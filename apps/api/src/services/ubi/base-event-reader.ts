/**
 * Base chain event reader for the Boundless market.
 *
 * Tails the BoundlessMarket contract on Base mainnet for `fulfill`
 * events targeting our platform prover address. Each accepted
 * fulfillment is one earning event:
 *   - ETH per-order fee (paid to our prover wallet immediately)
 *   - eventually-batched ZKC PoVW emissions (separate epoch-claim
 *     flow handled by the broker; epoch close drives UbiEarning
 *     roll-up in M4)
 *
 * Status: SKELETON. Defines the polling interface and the typed
 * event shape; the actual viem-based RPC call is gated behind
 * UBI_BOUNDLESS_ENABLED so the reader can run as a no-op in
 * production while we finish M2.1 + M2.2.
 *
 * Two reader modes (testability):
 *   - LIVE   : real Base RPC, reads on-chain events from
 *              BOUNDLESS_MARKET_ADDRESS
 *   - SYNTHETIC : reads queued events from the in-process simulator
 *              (services/ubi/simulator.ts). Used in tests and on
 *              staging until the broker is live.
 *
 * Live wiring (M2.5b) requires:
 *   - viem dep (not yet added; defer until M2.2 broker ready)
 *   - BASE_RPC_URL env (Render -> RPC provider)
 *   - persistent cursor (latest processed block) in Config table so
 *     we don't double-attribute on restart
 */

import type { PrismaClient } from '@a2e/database'
import {
  BOUNDLESS_BASE_CHAIN_ID,
  BOUNDLESS_MARKET_ADDRESS,
} from './boundless-adapter.js'

/**
 * Shape of a fulfilled-order event the reader emits to the rest of
 * the pipeline. Matches the abi of BoundlessMarket.RequestFulfilled
 * closely enough that the M2.5b wiring is a straight viem decode.
 */
export interface BoundlessFulfillEvent {
  // BoundlessMarket order request id (uint256). String to avoid
  // bigint serialization headaches.
  requestId: string
  // Wallet that bid + locked + fulfilled the order. Should equal our
  // platform prover address when LIVE, but verify before persisting.
  proverAddress: string
  // The zkVM program proven. Used as targetRef on the UbiProof row.
  imageId: string
  // Per-order fee paid in WEI (ETH wei on Base). String for bigint.
  feeWei: string
  // Block + tx for audit.
  blockNumber: number
  txHash: string
  blockTimestampSeconds: number
}

export interface EventReaderDeps {
  prisma: PrismaClient
  // Our platform prover wallet. Reader filters events to those whose
  // proverAddress matches; everything else is ignored.
  platformProverAddress: string
  // Optional cycle-attribution callback. Given a fulfilled event,
  // figure out which operator's Bento contributed the cycles for
  // it and write a (per-operator) cycle ledger row. Defaults to
  // a stub that attributes everything to the platform's "house"
  // node for M2.5 skeleton purposes.
  attributeCycles?: (event: BoundlessFulfillEvent) => Promise<void>
}

const ENABLED = process.env.UBI_BOUNDLESS_ENABLED === 'true'

/**
 * Process a fulfilled-order event. Idempotent on
 * (UbiProtocol.BOUNDLESS, requestId) thanks to the unique constraint
 * on UbiProof.
 */
export async function processFulfillEvent(
  deps: EventReaderDeps,
  event: BoundlessFulfillEvent,
): Promise<{ accrued: boolean; reason?: string }> {
  if (event.proverAddress.toLowerCase() !== deps.platformProverAddress.toLowerCase()) {
    return { accrued: false, reason: 'not_our_prover' }
  }

  // M2.6 hook: swap the ETH fee to USD spot at the moment of accrual.
  // Skeleton uses a placeholder USD value; real implementation calls
  // services/ubi/swap-rail.ts which routes through Uniswap V3.
  const grossUsd = await placeholderEthToUsd(BigInt(event.feeWei))

  try {
    await deps.prisma.ubiProof.create({
      data: {
        nodeId: 'platform-house-node', // M4 replaces this with the operator from cycle-attribution
        protocol: 'BOUNDLESS',
        aggregator: 'boundless-base-mainnet',
        externalProofId: event.requestId,
        targetRef: event.imageId,
        status: 'ACCEPTED',
        grossTokenAtto: event.feeWei,
        grossUsd,
        acceptedAt: new Date(event.blockTimestampSeconds * 1000),
      },
    })
  } catch (err) {
    // P2002 on (protocol, externalProofId) = duplicate event. Idempotent.
    const code = (err as { code?: string }).code
    if (code === 'P2002') {
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
 * Stub price lookup. M2.6 swap-rail provides the real one (calls
 * Uniswap V3 quoter at the current block).
 */
async function placeholderEthToUsd(weiAmount: bigint): Promise<number> {
  // 1 ETH = ~$3,500 USD as a coarse placeholder for skeleton math.
  // The real swap-rail returns the actual quoted output. This is
  // intentionally a stub so the skeleton compiles without external
  // dependencies.
  const PLACEHOLDER_ETH_USD = 3500
  const ethAmount = Number(weiAmount) / 1e18
  return Math.round(ethAmount * PLACEHOLDER_ETH_USD * 10000) / 10000
}

/**
 * Live polling loop. Skeleton no-ops when UBI_BOUNDLESS_ENABLED is
 * false; M2.5b adds viem + a real getLogs cursor.
 */
export async function tickEventReader(_deps: EventReaderDeps): Promise<{
  processed: number
  skipped: number
}> {
  if (!ENABLED) {
    return { processed: 0, skipped: 0 }
  }
  // M2.5b: viem getLogs against BOUNDLESS_MARKET_ADDRESS on Base
  // chain (BOUNDLESS_BASE_CHAIN_ID). Decode each into a
  // BoundlessFulfillEvent and call processFulfillEvent. Persist
  // cursor (highest processed block) to Config so restarts resume.
  void BOUNDLESS_MARKET_ADDRESS
  void BOUNDLESS_BASE_CHAIN_ID
  return { processed: 0, skipped: 0 }
}
