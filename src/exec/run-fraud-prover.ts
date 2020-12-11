import { Wallet } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { FraudProverService } from '../services/fraud-prover.service'

require('dotenv').config()

const env = process.env
const L2_NODE_WEB3_URL = env.L2_NODE_WEB3_URL
const L1_NODE_WEB3_URL = env.L1_NODE_WEB3_URL
const L1_WALLET_KEY = env.L1_WALLET_KEY
const RELAY_GAS_LIMIT = env.RELAY_GAS_LIMIT || '4000000'
const RUN_GAS_LIMIT = env.RUN_GAS_LIMIT || '95000000'
const POLLING_INTERVAL = env.POLLING_INTERVAL || '5000'
const L2_BLOCK_OFFSET = env.L2_BLOCK_OFFSET || '1'
const FROM_L2_TRANSACTION_INDEX = env.FROM_L2_TRANSACTION_INDEX || '0'

const main = async () => {
  const l2Provider = new JsonRpcProvider(L2_NODE_WEB3_URL)
  const l1Provider = new JsonRpcProvider(L1_NODE_WEB3_URL)

  const wallet = new Wallet(L1_WALLET_KEY, l1Provider)

  const service = new FraudProverService({
    l1RpcProvider: l1Provider,
    l2RpcProvider: l2Provider,
    l1Wallet: wallet,
    deployGasLimit: parseInt(RELAY_GAS_LIMIT, 10),
    pollingInterval: parseInt(POLLING_INTERVAL, 10),
    fromL2TransactionIndex: parseInt(FROM_L2_TRANSACTION_INDEX, 10),
    l2BlockOffset: parseInt(L2_BLOCK_OFFSET, 10),
    runGasLimit: parseInt(RUN_GAS_LIMIT, 10),
  })

  await service.start()
}

export default main