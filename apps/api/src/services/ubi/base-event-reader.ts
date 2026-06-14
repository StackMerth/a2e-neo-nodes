/**
 * Base chain event reader for the Boundless market.
 *
 * Tails the BoundlessMarket contract on Base mainnet for
 * RequestFulfilled events targeting our platform prover address.
 * Each accepted fulfillment is recorded as one UbiProof.ACCEPTED
 * row; the M4 epoch close rolls them up into UbiEarning rows with
 * the 95/5 split.
 *
 * Status: M2.5b live wiring. Gated behind UBI_BOUNDLESS_ENABLED so
 * production stays a no-op until M2.1 funds and M2.2 deploys the
 * broker. The viem reads themselves are free (mainnet event logs)
 * so we could turn this on for read-only observation today; the
 * gate is conservative because there's no purpose without a broker
 * actually fulfilling orders.
 *
 * Persistent cursor: stored in Config under
 * 'ubi:boundless:cursor-block'. Restarts resume from the last
 * processed block.
 *
 * Why we listen to RequestFulfilled (not ProofDelivered) for the
 * primary signal: RequestFulfilled is leaner (3 fields, both
 * critical ones indexed) and is the canonical "prover got paid"
 * marker. The actual fee amount comes from joining with the
 * original ProofRequest (M4 work — needs reading the request
 * mapping at the block of the fulfill). For the M2.5b skeleton we
 * record the fulfill with a placeholder grossUsd of 0; M4 reconciles
 * the real fee.
 */

import type { PrismaClient } from '@a2e/database'
import { createPublicClient, http, parseAbiItem, keccak256, toHex } from 'viem'
import { base } from 'viem/chains'
import {
  BOUNDLESS_BASE_CHAIN_ID,
  BOUNDLESS_MARKET_ADDRESS,
} from './boundless-adapter.js'

const ENABLED = process.env.UBI_BOUNDLESS_ENABLED === 'true'
const CURSOR_CONFIG_KEY = 'ubi:boundless:cursor-block'

// How far back to look on first run, when no cursor exists. Base
// produces a block every ~2s, so 1000 blocks is ~33 minutes. The
// scheduler ticks frequently enough to catch up from there.
const COLD_START_LOOKBACK_BLOCKS = 1000n

// Max range per getLogs call. Base RPC providers commonly limit
// at 10k blocks; we batch at 5k to stay clear and not trip rate
// limits.
const MAX_RANGE_BLOCKS = 5000n

/**
 * The canonical "prover got paid" event from BoundlessMarket.
 * Signature confirmed against IBoundlessMarket.sol and the
 * BaseScan-verified implementation.
 */
export const REQUEST_FULFILLED_ABI = parseAbiItem(
  'event RequestFulfilled(uint256 indexed requestId, address indexed prover, bytes32 requestDigest)',
)

/**
 * Topic0 hash of RequestFulfilled. Pre-computed at module load so
 * the reader doesn't recompute on every tick.
 */
export const REQUEST_FULFILLED_TOPIC = keccak256(
  toHex('RequestFulfilled(uint256,address,bytes32)'),
)

export interface BoundlessFulfillEvent {
  requestId: string
  proverAddress: string
  // Identifier of the original request payload. Used as targetRef
  // on UbiProof rows; the actual zkVM program hash is reconstructed
  // by M4 if needed for analytics.
  requestDigest: string
  // Per-order fee in WEI. NOT in the RequestFulfilled event; left
  // at "0" by the M2.5b reader. M4 fills it in by joining against
  // the prior ProofDelivered or by reading the request mapping at
  // the fulfill block.
  feeWei: string
  blockNumber: number
  txHash: string
  blockTimestampSeconds: number
}

export interface EventReaderDeps {
  prisma: PrismaClient
  // Our platform prover wallet on Base. Reader filters fulfill events
  // to those whose prover matches; everything else is ignored.
  platformProverAddress: string
  // Optional: handle cycle attribution per fulfilled event. M4 wires
  // this to the broker's per-Bento cycle ledger so earnings split
  // proportionally across operators who contributed.
  attributeCycles?: (event: BoundlessFulfillEvent) => Promise<void>
}

/**
 * Process a fulfilled-order event. Idempotent on
 * (UbiProtocol.BOUNDLESS, requestId) thanks to the unique constraint
 * on UbiProof.
 */
export async function processFulfillEvent(
  deps: EventReaderDeps,
  event: BoundlessFulfillEvent,
): Promise<{ accrued: boolean; reason?: string }> {
  if (
    event.proverAddress.toLowerCase() !==
    deps.platformProverAddress.toLowerCase()
  ) {
    return { accrued: false, reason: 'not_our_prover' }
  }

  // M2.6 hook: swap the ETH fee to USD spot at the moment of accrual.
  // Skeleton uses a placeholder USD value; real wiring calls
  // services/ubi/swap-rail.ts which routes through Uniswap V3.
  const grossUsd =
    event.feeWei === '0'
      ? 0
      : await placeholderEthToUsd(BigInt(event.feeWei))

  try {
    await deps.prisma.ubiProof.create({
      data: {
        nodeId: 'platform-house-node', // M4 replaces this with the operator from cycle-attribution
        protocol: 'BOUNDLESS',
        aggregator: 'boundless-base-mainnet',
        externalProofId: event.requestId,
        targetRef: event.requestDigest,
        status: 'ACCEPTED',
        grossTokenAtto: event.feeWei,
        grossUsd,
        acceptedAt: new Date(event.blockTimestampSeconds * 1000),
      },
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'P2002') {
      // Duplicate (protocol, externalProofId) — idempotent re-read.
      return { accrued: false, reason: 'duplicate' }
    }
    throw err
  }

  if (deps.attributeCycles) {
    await deps.attributeCycles(event)
  }
  return { accrued: true }
}

/**
 * Stub price lookup retained so the existing tests + simulator keep
 * working. M2.6 swap-rail provides the real one (calls Uniswap V3
 * QuoterV2 at the current block).
 */
async function placeholderEthToUsd(weiAmount: bigint): Promise<number> {
  const PLACEHOLDER_ETH_USD = 3500
  const ethAmount = Number(weiAmount) / 1e18
  return Math.round(ethAmount * PLACEHOLDER_ETH_USD * 10000) / 10000
}

/**
 * Build a viem PublicClient for Base mainnet. Lazy so we don't open
 * a connection unless the reader actually ticks.
 */
function getBaseClient() {
  const rpcUrl = process.env.BASE_RPC_URL
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl), // viem defaults to a public endpoint if undefined
  })
}

async function readCursorBlock(prisma: PrismaClient): Promise<bigint | null> {
  const row = await prisma.config.findUnique({ where: { key: CURSOR_CONFIG_KEY } })
  if (!row?.value) return null
  try {
    return BigInt(row.value)
  } catch {
    return null
  }
}

async function writeCursorBlock(
  prisma: PrismaClient,
  block: bigint,
): Promise<void> {
  await prisma.config.upsert({
    where: { key: CURSOR_CONFIG_KEY },
    create: { key: CURSOR_CONFIG_KEY, value: block.toString() },
    update: { value: block.toString() },
  })
}

/**
 * Live polling loop. No-ops when UBI_BOUNDLESS_ENABLED is false.
 *
 * When enabled:
 *  1. Read cursor block from Config (or compute cold-start from head)
 *  2. Read current head block from Base RPC
 *  3. For each batch of MAX_RANGE_BLOCKS up to head, viem.getLogs on
 *     BoundlessMarket filtered by the RequestFulfilled topic AND our
 *     prover address indexed topic
 *  4. processFulfillEvent for each match
 *  5. Persist cursor = highest processed block
 *
 * Skips block timestamps lookups per-event for performance; uses the
 * batch's head block timestamp as an approximation. M4 can swap to
 * per-event timestamps if accurate accruedAt matters.
 */
export async function tickEventReader(
  deps: EventReaderDeps,
): Promise<{ processed: number; skipped: number; cursor: string }> {
  if (!ENABLED) {
    return { processed: 0, skipped: 0, cursor: 'disabled' }
  }

  const client = getBaseClient()

  const head = await client.getBlockNumber()
  const cursor =
    (await readCursorBlock(deps.prisma)) ?? head - COLD_START_LOOKBACK_BLOCKS

  if (cursor >= head) {
    return { processed: 0, skipped: 0, cursor: head.toString() }
  }

  let processed = 0
  let skipped = 0
  let from = cursor + 1n

  while (from <= head) {
    const to = from + MAX_RANGE_BLOCKS - 1n > head ? head : from + MAX_RANGE_BLOCKS - 1n

    const logs = await client.getLogs({
      address: BOUNDLESS_MARKET_ADDRESS as `0x${string}`,
      event: REQUEST_FULFILLED_ABI,
      args: {
        prover: deps.platformProverAddress as `0x${string}`,
      },
      fromBlock: from,
      toBlock: to,
    })

    for (const log of logs) {
      const event: BoundlessFulfillEvent = {
        requestId: log.args.requestId?.toString() ?? '0',
        proverAddress: log.args.prover ?? '0x0000000000000000000000000000000000000000',
        requestDigest: log.args.requestDigest ?? '0x',
        feeWei: '0', // M4 reconciles
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash ?? '0x',
        blockTimestampSeconds: 0, // approximated below per-batch
      }
      // Batch-level timestamp approximation. Replace with per-block
      // lookup in M4 if accruedAt accuracy matters.
      const block = await client.getBlock({ blockNumber: log.blockNumber ?? to })
      event.blockTimestampSeconds = Number(block.timestamp)
      const result = await processFulfillEvent(deps, event)
      if (result.accrued) processed++
      else skipped++
    }

    await writeCursorBlock(deps.prisma, to)
    from = to + 1n
  }

  return { processed, skipped, cursor: head.toString() }
}

// Re-export constants for convenience
export { BOUNDLESS_BASE_CHAIN_ID, BOUNDLESS_MARKET_ADDRESS }
