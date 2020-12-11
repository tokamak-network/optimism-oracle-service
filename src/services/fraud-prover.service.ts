/* Imports: External */
import { Contract, Signer, ethers } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { BaseTrie } from 'merkle-patricia-tree'
import * as rlp from 'rlp'

/* Imports: Internal */
import { BaseService } from './base.service'
import {
  StateDiffProof,
  StateTransitionPhase,
  FraudProofData,
  OvmTransaction,
  StateRootBatchProof,
  TransactionBatchProof,
  AccountStateProof,
  StorageStateProof,
} from '../types'
import {
  sleep,
  ZERO_ADDRESS,
  loadContract,
  loadContractFromManager,
  L1ProviderWrapper,
  L2ProviderWrapper,
  toHexString,
  fromHexString,
  toStrippedHexString,
  encodeAccountState,
  hashOvmTransaction,
  toBytes32,
  makeTrieFromProofs,
} from '../utils'

interface FraudProverOptions {
  l1RpcProvider: JsonRpcProvider
  l2RpcProvider: JsonRpcProvider
  l1Wallet: Signer
  deployGasLimit: number
  runGasLimit: number
  pollingInterval: number
  fromL2TransactionIndex: number
  l2BlockOffset: number
}

export class FraudProverService extends BaseService<FraudProverOptions> {
  protected name = 'Fraud Prover'
  protected defaultOptions = {
    pollingInterval: 5000,
    deployGasLimit: 4_000_000,
    runGasLimit: 9_500_000,
    fromL2TransactionIndex: 0,
    l2BlockOffset: 1,
  }

  private state: {
    nextUnverifiedStateRoot: number
    l1Provider: L1ProviderWrapper
    l2Provider: L2ProviderWrapper
    Lib_AddressManager: Contract
    OVM_StateCommitmentChain: Contract
    OVM_CanonicalTransactionChain: Contract
    OVM_FraudVerifier: Contract
  }

  protected async _init(): Promise<void> {
    // Need to improve this, sorry.
    this.state = {} as any

    this.logger.info(`Trying to connect to the L1 network...`)
    for (let i = 0; i < 10; i++) {
      try {
        await this.options.l1RpcProvider.detectNetwork()
        this.logger.info(`Successfully connected to the L1 network.`)
        break
      } catch (err) {
        if (i < 9) {
          this.logger.info(
            `Unable to connect to L1 network, will try ${
              10 - i
            } more time(s)...`
          )
          await sleep(1000)
        } else {
          throw new Error(
            `Unable to connect to the L1 network, check that your L1 endpoint is correct.`
          )
        }
      }
    }

    this.logger.info(`Trying to connect to the L2 network...`)
    for (let i = 0; i < 10; i++) {
      try {
        await this.options.l2RpcProvider.detectNetwork()
        this.logger.info(`Successfully connected to the L2 network.`)
        break
      } catch (err) {
        if (i < 9) {
          this.logger.info(
            `Unable to connect to L2 network, will try ${
              10 - i
            } more time(s)...`
          )
          await sleep(1000)
        } else {
          throw new Error(
            `Unable to connect to the L2 network, check that your L2 endpoint is correct.`
          )
        }
      }
    }

    this.state.l2Provider = new L2ProviderWrapper(this.options.l2RpcProvider)

    this.logger.info(`Connecting to Lib_AddressManager...`)
    const addressManagerAddress = await this.state.l2Provider.getAddressManagerAddress()
    this.state.Lib_AddressManager = loadContract(
      'Lib_AddressManager',
      addressManagerAddress,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to Lib_AddressManager at address: ${this.state.Lib_AddressManager.address}`
    )

    this.logger.info('Connecting to OVM_StateCommitmentChain...')
    this.state.OVM_StateCommitmentChain = await loadContractFromManager(
      'OVM_StateCommitmentChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_StateCommitmentChain at address: ${this.state.OVM_StateCommitmentChain.address}`
    )

    this.logger.info('Connecting to OVM_CanonicalTransactionChain...')
    this.state.OVM_CanonicalTransactionChain = await loadContractFromManager(
      'OVM_CanonicalTransactionChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_CanonicalTransactionChain at address: ${this.state.OVM_CanonicalTransactionChain.address}`
    )

    this.logger.info('Connecting to OVM_FraudVerifier...')
    this.state.OVM_FraudVerifier = await loadContractFromManager(
      'OVM_FraudVerifier',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_FraudVerifier at address: ${this.state.OVM_FraudVerifier.address}`
    )

    this.logger.success('Connected to all contracts.')

    this.state.l1Provider = new L1ProviderWrapper(
      this.options.l1RpcProvider,
      this.state.OVM_StateCommitmentChain,
      this.state.OVM_CanonicalTransactionChain
    )

    this.state.nextUnverifiedStateRoot =
      this.options.fromL2TransactionIndex || 0
  }

  protected async _start(): Promise<void> {
    while (this.running) {
      await sleep(this.options.pollingInterval)

      try {
        this.logger.info(`Looking for mismatched state roots...`)
        const fraudulentStateRootIndex = await this._findNextFraudulentStateRoot()

        if (fraudulentStateRootIndex === undefined) {
          this.logger.info(
            `Didn't find any mismatched state roots. Trying again in ${Math.floor(
              this.options.pollingInterval / 1000
            )} seconds...`
          )
          continue
        }

        this.logger.interesting(
          `Found a mismatched state root at index: ${fraudulentStateRootIndex}`
        )

        this.logger.info(`Pulling fraud proof data...`)
        const proof = await this._getFraudProofData(fraudulentStateRootIndex)

        this.logger.info(`Initializing the fraud verification process...`)
        await this._initializeFraudVerification(
          proof.preStateRootProof,
          proof.transactionProof
        )

        this.logger.info(`Loading fraud proof contracts...`)
        const {
          OVM_StateTransitioner,
          OVM_StateManager,
        } = await this._getFraudProofContracts(
          await this.state.l1Provider.getStateRoot(
            fraudulentStateRootIndex - 1
          ),
          proof.transactionProof.transaction
        )

        // PRE_EXECUTION phase.
        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.PRE_EXECUTION
        ) {
          try {
            this.logger.interesting(
              `Fraud proof is now in the PRE_EXECUTION phase.`
            )

            this.logger.interesting(`Proving account states...`)
            await this._proveAccountStates(
              OVM_StateTransitioner,
              OVM_StateManager,
              proof.stateDiffProof.accountStateProofs,
              fraudulentStateRootIndex
            )

            this.logger.interesting(`Proving storage slot states...`)
            await this._proveContractStorageStates(
              OVM_StateTransitioner,
              proof.stateDiffProof.accountStateProofs
            )

            this.logger.interesting(`Executing transaction...`)
            await OVM_StateTransitioner.applyTransaction(
              proof.transactionProof.transaction,
              {
                gasLimit: this.options.runGasLimit,
              }
            )

            this.logger.success(`Transaction successfully executed.`)
          } catch (err) {
            if (
              err
                .toString()
                .includes('Function must be called during the correct phase.')
            ) {
              this.logger.interesting(
                `Phase was completed by someone else, moving on.`
              )
            } else {
              throw err
            }
          }
        }

        // POST_EXECUTION phase.
        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.POST_EXECUTION
        ) {
          try {
            this.logger.interesting(
              `Fraud proof is now in the POST_EXECUTION phase.`
            )

            this.logger.interesting(`Committing storage slot state updates...`)
            await this._updateContractStorageStates(
              OVM_StateTransitioner,
              OVM_StateManager,
              proof.stateDiffProof.accountStateProofs,
              proof.storageTries
            )

            this.logger.interesting(`Committing account state updates...`)
            await this._updateAccountStates(
              OVM_StateTransitioner,
              OVM_StateManager,
              proof.stateDiffProof.accountStateProofs,
              proof.stateTrie
            )

            this.logger.interesting(`Completing the state transition...`)
            await OVM_StateTransitioner.completeTransition()

            this.logger.success(`State transition completed.`)
          } catch (err) {
            if (
              err
                .toString()
                .includes('Function must be called during the correct phase.')
            ) {
              this.logger.interesting(
                `Phase was completed by someone else, moving on.`
              )
            } else {
              throw err
            }
          }
        }

        // COMPLETE phase.
        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.COMPLETE
        ) {
          this.logger.interesting(`Fraud proof is now in the COMPLETE phase.`)

          this.logger.interesting(`Attempting to finalize the fraud proof...`)
          try {
            await this._finalizeFraudVerification(
              proof.preStateRootProof,
              proof.postStateRootProof,
              proof.transactionProof.transaction
            )

            this.logger.success(`Fraud proof finalized! Congrats.`)
          } catch (err) {
            if (
              err.toString().includes('Invalid batch header.') ||
              err.toString().includes('Index out of bounds.')
            ) {
              this.logger.success(
                `Fraud proof was finalized by someone else. Congrats!`
              )
            } else {
              throw err
            }
          }
        }

        this.state.nextUnverifiedStateRoot = proof.preStateRootProof.stateRootBatchHeader.prevTotalElements.toNumber()
      } catch (err) {
        this.logger.error(
          `Caught an unhandled error, see error log below:\n\n${err}\n`
        )
      }
    }
  }

  /**
   * Finds the index of the next fraudulent state root.
   * @return Index of the next fraudulent state root, if any.
   */
  private async _findNextFraudulentStateRoot(): Promise<number | undefined> {
    while (
      (await this.state.l1Provider.getStateRootBatchHeader(
        this.state.nextUnverifiedStateRoot
      )) !== undefined
    ) {
      this.logger.info(
        `Checking state root for mismatch: ${this.state.nextUnverifiedStateRoot}`
      )

      const l1StateRoot = await this.state.l1Provider.getStateRoot(
        this.state.nextUnverifiedStateRoot
      )

      const l2StateRoot = await this.state.l2Provider.getStateRoot(
        this.state.nextUnverifiedStateRoot + this.options.l2BlockOffset
      )

      if (l1StateRoot !== l2StateRoot) {
        return this.state.nextUnverifiedStateRoot
      } else {
        this.state.nextUnverifiedStateRoot += 1
      }
    }
  }

  /**
   * Generates all transaction proof data for a given transaction index.
   * @param transactionIndex Transaction index to get proof data for.
   * @return Transaction proof data.
   */
  private async _getFraudProofData(
    transactionIndex: number
  ): Promise<FraudProofData> {
    this.logger.info(`Getting pre-state root inclusion proof...`)
    const preStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      transactionIndex - 1
    )

    this.logger.info(`Getting post-state root inclusion proof...`)
    const postStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      transactionIndex
    )

    this.logger.info(`Getting transaction inclusion proof...`)
    const transactionProof = await this.state.l1Provider.getTransactionBatchProof(
      transactionIndex
    )

    this.logger.info(`Getting state diff proof...`)
    const stateDiffProof: StateDiffProof = await this.state.l2Provider.getStateDiffProof(
      transactionIndex + this.options.l2BlockOffset - 1
    )

    const stateTrie = await this._makeStateTrie(stateDiffProof)
    const storageTries = await this._makeAccountTries(stateDiffProof)

    return {
      stateDiffProof,
      transactionProof,
      preStateRootProof,
      postStateRootProof,
      stateTrie,
      storageTries,
    }
  }

  /**
   * Pulls the fraud proof contracts.
   * @param preStateRoot Pre-state root to pull contracts for.
   * @param transaction Transaction to pull contracts for.
   * @return Fraud proof contracts.
   */
  private async _getFraudProofContracts(
    preStateRoot: string,
    transaction: OvmTransaction
  ): Promise<{
    OVM_StateTransitioner: Contract
    OVM_StateManager: Contract
  }> {
    this.logger.info(`Loading the state transitioner...`)

    const stateTransitionerAddress = await this._getStateTransitioner(
      preStateRoot,
      transaction
    )

    const OVM_StateTransitioner = loadContract(
      'OVM_StateTransitioner',
      stateTransitionerAddress,
      this.options.l1RpcProvider
    ).connect(this.options.l1Wallet)

    this.logger.info(
      `State transitioner is at address: ${stateTransitionerAddress}`
    )

    this.logger.info(`Loading the corresponding state manager...`)

    const stateManagerAddress = await OVM_StateTransitioner.ovmStateManager()
    const OVM_StateManager = loadContract(
      'OVM_StateManager',
      stateManagerAddress,
      this.options.l1RpcProvider
    ).connect(this.options.l1Wallet)

    this.logger.info(`State manager is at address: ${stateManagerAddress}`)

    return {
      OVM_StateTransitioner,
      OVM_StateManager,
    }
  }

  /**
   * Generates a view of the state trie from a state diff proof.
   * @param proof State diff proof to generate a trie from.
   * @return View of the state trie.
   */
  private async _makeStateTrie(proof: StateDiffProof): Promise<BaseTrie> {
    return makeTrieFromProofs(
      proof.accountStateProofs.map((accountStateProof) => {
        return accountStateProof.accountProof
      })
    )
  }

  /**
   * Generates a view of a set of account tries from a state diff proof.
   * @param proof State diff proof to generate tries from.
   * @return View of a set of all account tries.
   */
  private async _makeAccountTries(
    proof: StateDiffProof
  ): Promise<{
    [address: string]: BaseTrie
  }> {
    let accountTries: { [address: string]: BaseTrie } = {}

    for (const accountStateProof of proof.accountStateProofs) {
      accountTries[accountStateProof.address] = await makeTrieFromProofs(
        accountStateProof.storageProof.map((storageProof) => {
          return storageProof.proof
        })
      )
    }

    return accountTries
  }

  /**
   * Retrieves the state transitioner correspondng to a given pre-state root and transaction.
   * @param preStateRoot Pre-state root to retreive a state transitioner for.
   * @param transaction Transaction to retreive a state transitioner for.
   * @return Address of the corresponding state transitioner.
   */
  private async _getStateTransitioner(
    preStateRoot: string,
    transaction: OvmTransaction
  ): Promise<string> {
    return this.state.OVM_FraudVerifier.getStateTransitioner(
      preStateRoot,
      hashOvmTransaction(transaction)
    )
  }

  /**
   * Simple mechanism for deploying an exact bytecode to a given address. Resulting contract will
   * have code exactly matching the given `code` variable, and none of the code will be executed
   * during creation.
   * @param code Code to store at a given address.
   * @return Address of the newly created contract.
   */
  private async _deployContractCode(code: string): Promise<string> {
    // "Magic" prefix to be prepended to the contract code. Contains a series of opcodes that will
    // copy the given code into memory and return it, thereby storing at the contract address.
    const prefix = '0x600D380380600D6000396000f3'
    const deployCode = prefix + toHexString(code).slice(2)

    const response = await this.options.l1Wallet.sendTransaction({
      to: null,
      data: deployCode,
      gasLimit: this.options.deployGasLimit,
    })

    const result = await response.wait()
    return result.contractAddress
  }

  /**
   * Proves the state of all given accounts.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   * @param fraudulentStateRootIndex Index of the fraudulent state root.
   */
  private async _proveAccountStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[],
    fraudulentStateRootIndex: number
  ): Promise<void> {
    for (const accountStateProof of accountStateProofs) {
      this.logger.info(
        `Attempting to prove account state: ${accountStateProof.address}`
      )

      if (await OVM_StateManager.hasAccount(accountStateProof.address)) {
        this.logger.info(
          `Someone else already proved this account, skipping...`
        )
      }

      const accountCode = await this.options.l2RpcProvider.getCode(
        accountStateProof.address,
        fraudulentStateRootIndex + this.options.l2BlockOffset
      )

      let ethContractAddress = '0x0000c0De0000C0DE0000c0de0000C0DE0000c0De'
      if (accountCode !== '0x') {
        this.logger.info(`Need to deploy a copy of the account first...`)
        ethContractAddress = await this._deployContractCode(accountCode)
        this.logger.info(`Deployed a copy of the account, attempting proof...`)
      }

      try {
        await OVM_StateTransitioner.proveContractState(
          accountStateProof.address,
          ethContractAddress,
          rlp.encode(accountStateProof.accountProof)
        )

        this.logger.success(`Account state proven.`)
      } catch (err) {
        if (err.toString().includes('Account state has already been proven')) {
          this.logger.info(
            `Someone else has already proven this account, skipping.`
          )
        } else {
          throw err
        }
      }
    }
  }

  /**
   * Proves all contract storage slot states.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   */
  private async _proveContractStorageStates(
    OVM_StateTransitioner: Contract,
    accountStateProofs: AccountStateProof[]
  ): Promise<void> {
    for (const accountStateProof of accountStateProofs) {
      for (const slot of accountStateProof.storageProof) {
        this.logger.info(`Attempting to prove slot.`)
        this.logger.info(`Address: ${accountStateProof.address}`)
        this.logger.info(`Key: ${slot.key}`)
        this.logger.info(`Value: ${slot.value}`)

        try {
          await OVM_StateTransitioner.proveStorageSlot(
            accountStateProof.address,
            toBytes32(slot.key),
            rlp.encode(slot.proof)
          )

          this.logger.success(`Slot value proven.`)
        } catch (err) {
          if (
            err.toString().includes('Storage slot has already been proven.')
          ) {
            this.logger.info(
              `Someone else has already proven this slot, skipping.`
            )
          } else {
            throw err
          }
        }
      }
    }
  }

  /**
   * Commits all account state changes.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   * @param stateTrie State trie view generated from proof data.
   */
  private async _updateAccountStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[],
    stateTrie: BaseTrie
  ): Promise<void> {
    while ((await OVM_StateManager.getTotalUncommittedAccounts()) > 0) {
      const accountCommittedEvents = await OVM_StateTransitioner.queryFilter(
        OVM_StateTransitioner.filters.AccountCommitted()
      )

      // Use events to figure out which accounts we've already committed.
      const committedAccounts = accountStateProofs.filter((account) => {
        return accountCommittedEvents.some((event) => {
          return (
            event.args._address.toLowerCase() === account.address.toLowerCase()
          )
        })
      })

      // Update our trie with the values of any accounts that have already been committed. Order
      // here doesn't matter because the trie will still end up with the same root. We can also
      // repeatedly update a key with the same value since it won't have an impact on the trie.
      for (const account of committedAccounts) {
        const updatedAccountState = await OVM_StateManager.getAccount(
          account.address
        )

        await stateTrie.put(
          fromHexString(ethers.utils.keccak256(account.address)),
          encodeAccountState({
            ...updatedAccountState,
            ...{
              nonce: updatedAccountState.nonce.toNumber(),
            },
          })
        )
      }

      // Find an uncommitted account to attempt to commit.
      let nextUncommittedAccount: AccountStateProof
      for (const account of accountStateProofs) {
        if (
          !(await OVM_StateManager.wasAccountCommitted(account.address)) &&
          (await OVM_StateManager.wasAccountChanged(account.address))
        ) {
          nextUncommittedAccount = account
          break
        }
      }

      if (nextUncommittedAccount === undefined) {
        if ((await OVM_StateManager.getTotalUncommittedAccounts()) > 0) {
          throw new Error(
            `We still have accounts to commit, but we don't have any more proof data. Something went very wrong.`
          )
        } else {
          return
        }
      }

      // Generate an inclusion proof for the account, will be used to update the value on-chain.
      const accountInclusionProof = toHexString(
        rlp.encode(
          await BaseTrie.createProof(
            stateTrie,
            fromHexString(
              ethers.utils.keccak256(nextUncommittedAccount.address)
            )
          )
        )
      )

      const updatedAccountState = await OVM_StateManager.getAccount(
        nextUncommittedAccount.address
      )

      this.logger.info(`Attempting to commit account.`)
      this.logger.info(`Address: ${nextUncommittedAccount.address}`)
      this.logger.info(`Balance: ${updatedAccountState.balance}`)
      this.logger.info(`Nonce: ${updatedAccountState.nonce}`)
      this.logger.info(`Storage Root: ${updatedAccountState.storageRoot}`)
      this.logger.info(`Code Hash: ${updatedAccountState.codeHash}`)

      try {
        await OVM_StateTransitioner.commitContractState(
          nextUncommittedAccount.address,
          accountInclusionProof,
          {
            gasLimit: this.options.deployGasLimit,
          }
        )

        this.logger.success(`Account committed.`)
      } catch (err) {
        if (
          err.toString().includes('invalid opcode') ||
          err.toString().includes('Invalid root hash') ||
          err
            .toString()
            .includes(
              `Account state wasn't changed or has already been committed.`
            )
        ) {
          this.logger.info(
            `Could not commit account because another commitment invalidated our proof, skipping for now...`
          )
        } else {
          throw err
        }
      }
    }
  }

  /**
   * Commits all contract storage slot changes.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   * @param stateTrie State trie view generated from proof data.
   * @param storageTries Storage trie views generated from proof data.
   */
  private async _updateContractStorageStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[],
    storageTries: {
      [address: string]: BaseTrie
    }
  ) {
    while ((await OVM_StateManager.getTotalUncommittedContractStorage()) > 0) {
      const storageCommittedEvents = await OVM_StateTransitioner.queryFilter(
        OVM_StateTransitioner.filters.ContractStorageCommitted()
      )

      for (const accountStateProof of accountStateProofs) {
        const committedStorageSlots = accountStateProof.storageProof.filter(
          (storageProof) => {
            return storageCommittedEvents.some((event) => {
              return (
                event.args._address.toLowerCase() ===
                  accountStateProof.address.toLowerCase() &&
                event.args._key.toLowerCase() === storageProof.key.toLowerCase()
              )
            })
          }
        )

        for (const storageProof of committedStorageSlots) {
          const updatedSlotValue = await OVM_StateManager.getContractStorage(
            accountStateProof.address,
            storageProof.key
          )

          await storageTries[accountStateProof.address].put(
            fromHexString(ethers.utils.keccak256(storageProof.key)),
            fromHexString(rlp.encode(toStrippedHexString(updatedSlotValue)))
          )
        }
      }

      for (const accountStateProof of accountStateProofs) {
        let nextUncommittedStorageProof: StorageStateProof
        for (const storageProof of accountStateProof.storageProof) {
          if (
            !(await OVM_StateManager.wasContractStorageCommitted(
              accountStateProof.address,
              storageProof.key
            )) &&
            (await OVM_StateManager.wasContractStorageChanged(
              accountStateProof.address,
              storageProof.key
            ))
          ) {
            nextUncommittedStorageProof = storageProof
            break
          }
        }

        if (nextUncommittedStorageProof === undefined) {
          continue
        }

        const slotInclusionProof = toHexString(
          rlp.encode(
            await BaseTrie.createProof(
              storageTries[accountStateProof.address],
              fromHexString(
                ethers.utils.keccak256(nextUncommittedStorageProof.key)
              )
            )
          )
        )

        const updatedSlotValue = await OVM_StateManager.getContractStorage(
          accountStateProof.address,
          nextUncommittedStorageProof.key
        )

        this.logger.info(`Attempting to commit storage slot.`)
        this.logger.info(`Address: ${accountStateProof.address}`)
        this.logger.info(`Key: ${nextUncommittedStorageProof.key}`)
        this.logger.info(`Value: ${updatedSlotValue}`)

        try {
          await OVM_StateTransitioner.commitStorageSlot(
            accountStateProof.address,
            nextUncommittedStorageProof.key,
            slotInclusionProof,
            {
              gasLimit: this.options.deployGasLimit,
            }
          )

          this.logger.success(`Storage slot committed.`)
        } catch (err) {
          if (
            err.toString().includes('invalid opcode') ||
            err.toString().includes('Invalid root hash') ||
            err
              .toString()
              .includes(
                `Storage slot value wasn't changed or has already been committed.`
              )
          ) {
            this.logger.info(
              `Could not commit slot because another commitment invalidated our proof, skipping for now...`
            )
          } else {
            throw err
          }
        }
      }
    }
  }

  /**
   * Initializes the fraud verification process.
   * @param preStateRootProof Proof data for the pre-state root.
   * @param transactionProof Proof data for the transaction being verified.
   */
  private async _initializeFraudVerification(
    preStateRootProof: StateRootBatchProof,
    transactionProof: TransactionBatchProof
  ): Promise<void> {
    const stateTransitionerAddress = await this._getStateTransitioner(
      preStateRootProof.stateRoot,
      transactionProof.transaction
    )

    if (stateTransitionerAddress !== ZERO_ADDRESS) {
      return
    }

    await this.state.OVM_FraudVerifier.connect(
      this.options.l1Wallet
    ).initializeFraudVerification(
      preStateRootProof.stateRoot,
      preStateRootProof.stateRootBatchHeader,
      preStateRootProof.stateRootProof,
      transactionProof.transaction,
      transactionProof.transactionChainElement,
      transactionProof.transactionBatchHeader,
      transactionProof.transactionProof
    )
  }

  /**
   * Finalizes the fraud verification process.
   * @param preStateRootProof Proof data for the pre-state root.
   * @param postStateRootProof Proof data for the post-state root.
   * @param transaction Transaction being verified.
   */
  private async _finalizeFraudVerification(
    preStateRootProof: StateRootBatchProof,
    postStateRootProof: StateRootBatchProof,
    transaction: OvmTransaction
  ): Promise<void> {
    await this.state.OVM_FraudVerifier.connect(
      this.options.l1Wallet
    ).finalizeFraudVerification(
      preStateRootProof.stateRoot,
      preStateRootProof.stateRootBatchHeader,
      preStateRootProof.stateRootProof,
      hashOvmTransaction(transaction),
      postStateRootProof.stateRoot,
      postStateRootProof.stateRootBatchHeader,
      postStateRootProof.stateRootProof
    )
  }
}