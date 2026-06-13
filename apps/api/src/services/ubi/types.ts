/**
 * ZK-UBI shared types.
 *
 * Adapter-agnostic shapes that the scheduler, the per-protocol
 * adapters (Filecoin C2, Aleo, StarkNet), and the payout pipeline
 * all speak. The schema mirrors these types one-for-one; if you add
 * a field here, check whether it belongs on UbiProof or UbiEarning
 * in packages/database/prisma/schema.prisma.
 */

import type { UbiProtocol } from '@a2e/database'

/**
 * Work the scheduler dispatches to an operator's node. The aggregator
 * returns one of these when polled; the scheduler chooses which idle
 * UBI-opted-in node to assign it to and writes a PENDING UbiProof
 * row before the node starts work.
 */
export interface UbiWorkItem {
  // Aggregator-side identifier. Globally unique within (protocol,
  // aggregator). Becomes UbiProof.externalProofId.
  externalProofId: string
  // What the proof attests to (Filecoin sector id, Aleo program id,
  // etc.). Stored as targetRef.
  targetRef: string
  // Free-form aggregator name. Tracked so we can multi-source per
  // protocol (e.g. HOKU + GLIF on Filecoin C2).
  aggregator: string
  // Estimated wall-clock budget for the proof. The scheduler uses
  // this to decide whether the node can pick it up given the
  // expected idle window.
  estimatedDurationSeconds: number
  // Bytes of disk the operator must have free to take this work.
  // Filecoin C2 needs sector-size disk (32GB / 64GB); other
  // protocols may be pure compute.
  requiredDiskBytes: number
  // Opaque payload the adapter passes to the operator's worker
  // process. Each protocol defines its own shape; the scheduler is
  // protocol-blind. Encrypted at rest if the aggregator requires.
  workPayload: Record<string, unknown>
}

/**
 * What an operator's worker returns when it finishes the proof. The
 * adapter submits this back to the aggregator and, if accepted,
 * we mark the UbiProof row ACCEPTED + record the earnings.
 */
export interface UbiProofResult {
  externalProofId: string
  // Proof bytes (SNARK output, signature, etc.) the aggregator
  // verifies. Base64 in transit.
  proofBytes: string
  // Operator-side compute metrics, optional. Used for ops dashboards
  // (proof-rate by gpuTier, etc.) not billing.
  metrics?: {
    gpuSeconds?: number
    peakGpuMemoryGb?: number
    walltimeSeconds?: number
  }
}

/**
 * What the aggregator tells us when we submit a result.
 */
export interface UbiProofAcceptance {
  accepted: boolean
  // Token amount earned, as a decimal string (atto-FIL for Filecoin,
  // microALEO for Aleo, etc.). Empty / '0' when rejected.
  grossTokenAtto: string
  // USD equivalent at the moment of acceptance. The adapter is
  // responsible for the conversion (either the aggregator quotes USD
  // directly, or the adapter looks up FIL/USD spot at acceptance time).
  grossUsd: number
  // Aggregator's reason for rejection, when not accepted.
  rejectionReason?: string
}

/**
 * Per-protocol adapter. Each ZK-UBI protocol (Filecoin C2, Aleo,
 * StarkNet) implements this interface; the scheduler and payout
 * pipeline never touch protocol-specific code.
 */
export interface UbiAdapter {
  protocol: UbiProtocol

  /**
   * Pull available work from the aggregator. Called by the scheduler
   * tick. Empty array is normal (no work right now).
   */
  pollWorkAvailable(): Promise<UbiWorkItem[]>

  /**
   * Forward a finished proof result to the aggregator and report
   * whether it was accepted. Called by the worker callback once the
   * operator's node submits a result.
   */
  submitProofResult(result: UbiProofResult): Promise<UbiProofAcceptance>

  /**
   * Health check the scheduler runs before each tick. Disabled
   * adapters return false; the scheduler skips them.
   */
  isHealthy(): Promise<boolean>
}

/**
 * Operator-side payout calculation. 95/5 passthrough per the
 * architecture decision: operator gets 95% of grossUsd, platform
 * gets 5%. Exported so the payout pipeline and any read-side UI
 * compute the same value.
 */
export interface UbiPayoutSplit {
  operatorUsd: number
  platformUsd: number
}

export const UBI_OPERATOR_SHARE = 0.95
export const UBI_PLATFORM_SHARE = 0.05

export function splitUbiPayout(grossUsd: number): UbiPayoutSplit {
  // Match the 4-decimal rounding the existing Earning + InternalSpend
  // tables use so reconciliation across the two ledgers is exact.
  const round4 = (n: number): number => Math.round(n * 10000) / 10000
  const operatorUsd = round4(grossUsd * UBI_OPERATOR_SHARE)
  // Compute platform as the remainder so the two slices sum exactly
  // to gross without floating-point drift on each call.
  const platformUsd = round4(grossUsd - operatorUsd)
  return { operatorUsd, platformUsd }
}
