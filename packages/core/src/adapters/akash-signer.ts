/**
 * Akash signer + chain SDK factory.
 *
 * Builds a chain-sdk client backed by a BIP-39 mnemonic. The returned object
 * exposes:
 *   - `address`: the bech32 sender (akash1…)
 *   - `sdk`: the typed Akash chain SDK (sdk.akash.cert.v1.createCertificate(...) etc.)
 *   - `txClient`: the underlying StargateTxClient for fee estimation, raw sign+broadcast
 *   - `disconnect()`: graceful shutdown
 *
 * Lazy: nothing connects to the chain until you call createAkashSigner().
 * deriveAkashAddress is a separate, network-free helper for off-chain checks.
 */

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import {
  createChainNodeSDK,
  createStargateClient,
  type ChainNodeSDK,
  type StargateClientOptions,
} from '@akashnetwork/chain-sdk'

type StargateTxClient = ReturnType<typeof createStargateClient>

const DEFAULT_RPC_URL = 'https://rpc.akashnet.net:443'
const DEFAULT_GRPC_URL = 'https://grpc.akashnet.net:443'

export interface AkashSignerOptions {
  /** BIP-39 mnemonic. If omitted, read from process.env.AKASH_MNEMONIC. */
  mnemonic?: string
  /** Akash RPC endpoint (used for transaction broadcast). */
  rpcUrl?: string
  /** Akash gRPC-Web endpoint (used for typed queries). */
  grpcUrl?: string
}

export interface AkashSigner {
  address: string
  sdk: ChainNodeSDK
  txClient: StargateTxClient
  disconnect: () => Promise<void>
}

/**
 * Build an Akash signer + chain SDK from a mnemonic. Connects to the
 * configured RPC + gRPC endpoints. Caller is responsible for calling
 * disconnect() when done.
 */
export async function createAkashSigner(options: AkashSignerOptions = {}): Promise<AkashSigner> {
  const mnemonic = options.mnemonic ?? process.env.AKASH_MNEMONIC
  if (!mnemonic) {
    throw new Error('Akash signer: AKASH_MNEMONIC env var or options.mnemonic required')
  }

  const rpcUrl = options.rpcUrl ?? process.env.AKASH_RPC_URL ?? DEFAULT_RPC_URL
  const grpcUrl = options.grpcUrl ?? process.env.AKASH_GRPC_URL ?? DEFAULT_GRPC_URL

  // Pre-derive the address so we can return it before any RPC round-trip.
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'akash' })
  const accounts = await wallet.getAccounts()
  const account = accounts[0]
  if (!account) {
    throw new Error('Akash signer: wallet returned no accounts (malformed mnemonic?)')
  }

  // Stargate client: handles tx signing + broadcast.
  const txClient = createStargateClient({
    baseUrl: rpcUrl,
    signer: wallet,
  } as StargateClientOptions)

  // Typed chain SDK: handles typed query/tx via gRPC.
  const sdk = createChainNodeSDK({
    query: { baseUrl: grpcUrl },
    tx: { signer: txClient },
  })

  return {
    address: account.address,
    sdk,
    txClient,
    disconnect: () => txClient.disconnect(),
  }
}

/**
 * Off-chain address derivation. No RPC connection. Useful for preflight
 * sanity checks (does this mnemonic produce the expected wallet?).
 */
export async function deriveAkashAddress(mnemonic?: string): Promise<string> {
  const m = mnemonic ?? process.env.AKASH_MNEMONIC
  if (!m) {
    throw new Error('Akash address derivation: AKASH_MNEMONIC env var or arg required')
  }
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(m, { prefix: 'akash' })
  const accounts = await wallet.getAccounts()
  if (!accounts[0]) {
    throw new Error('Akash address derivation: wallet returned no accounts')
  }
  return accounts[0].address
}
