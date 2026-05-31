/**
 * Track 5 / M1.1 — credit an inference call's revenue under Model C.
 *
 * Called from the inference meter (services/inference/meter.ts) right
 * after the buyer's SPEND_INFERENCE debit lands. Wires the gross
 * payment through the M0.2 splitRevenue() helper:
 *
 *   - Operator (the inference worker's host) gets cost + 50% of net
 *     when their Node.nodeRunner.userId is set on the call
 *   - When operatorId is null (platform-served inference — e.g. E2's
 *     proxy to an external provider during early rollout), the
 *     platform IS the operator; TREASURY_USER_ID stands in so cost +
 *     50% of net flow to treasury
 *   - Staking pool gets 25% of net
 *   - Treasury gets 25% of net (additional to the operator slice
 *     when platform-served — same code path, treasury just collects
 *     both halves in that case)
 *
 * Kill switch: REVENUE_SPLIT_ENABLED env. When OFF, this is a no-op
 * and the meter's behavior is unchanged — buyer's SPEND_INFERENCE
 * debit just sits in admin custody as before.
 *
 * Cost-of-service for inference: %-of-gross via
 * INFERENCE_COST_OF_SERVICE_PCT env (default 0.30 / 30%). Rationale:
 * unlike rentals where we have GPU SKU + duration → cost from
 * GpuCostBaseline, inference cost is dominated by per-token compute
 * which we don't currently meter at the operator level. A flat %
 * keeps the split's accounting honest until E2's router actually
 * measures per-call compute load.
 *
 * Idempotency: splitRevenue is unique on referenceId; we pass the
 * inference request id which is the same one the meter used for
 * SPEND_INFERENCE. A retry returns the existing audit row without
 * re-crediting anyone.
 */

import type { PrismaClient } from '@a2e/database'
import { splitRevenue, isRevenueSplitEnabled, type SplitRevenueResult } from './split.js'

const DEFAULT_INFERENCE_COST_PCT = 0.30

function getInferenceCostPct(): number {
  const raw = process.env.INFERENCE_COST_OF_SERVICE_PCT
  if (!raw) return DEFAULT_INFERENCE_COST_PCT
  const parsed = parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
    return DEFAULT_INFERENCE_COST_PCT
  }
  return parsed
}

export interface CreditInferenceCallArgs {
  /** InferenceRequest / call id — same value the meter used as referenceId. */
  referenceId: string
  /** Buyer's billed cost in USD — same value as the SPEND_INFERENCE debit. */
  grossUsd: number
  /** Node id of the inference worker that served the call. Null when platform-served. */
  operatorNodeId?: string | null
  /** Model name for the audit row's description. */
  model: string
}

export interface CreditInferenceCallResult {
  /** True when the kill switch was ON and a split was attempted. */
  applied: boolean
  /** Present only when applied=true. */
  split?: SplitRevenueResult
  /** Resolved operator user id (real operator's userId or TREASURY_USER_ID). */
  operatorUserId?: string
  /** Cost-of-service used in the calculation. */
  costUsd?: number
}

/**
 * Atomic, idempotent helper. Safe to call after every meter run; a
 * second call with the same referenceId returns the prior audit row
 * without re-crediting.
 */
export async function creditInferenceCall(
  prisma: PrismaClient,
  args: CreditInferenceCallArgs,
): Promise<CreditInferenceCallResult> {
  if (!isRevenueSplitEnabled()) return { applied: false }
  if (args.grossUsd <= 0) return { applied: false }

  let operatorUserId: string | null = null
  if (args.operatorNodeId) {
    const node = await prisma.node.findUnique({
      where: { id: args.operatorNodeId },
      select: { nodeRunner: { select: { userId: true } } },
    })
    operatorUserId = node?.nodeRunner?.userId ?? null
  }

  if (!operatorUserId) {
    const treasuryUserId = process.env.TREASURY_USER_ID?.trim()
    if (!treasuryUserId) {
      // Without TREASURY_USER_ID we can't route the operator slice
      // for platform-served inference. Log + fall back to no-split
      // rather than throwing — meter has already debited the buyer,
      // and we never want a missing env to break the inference path.
      console.error(
        '[inference-credit] TREASURY_USER_ID not set; cannot route operator slice for platform-served inference. Run seed-system-accounts and add TREASURY_USER_ID to Render env.',
      )
      return { applied: false }
    }
    operatorUserId = treasuryUserId
  }

  const costUsd = round4(args.grossUsd * getInferenceCostPct())

  const split = await splitRevenue(prisma, {
    sourceTxType: 'SPEND_INFERENCE',
    referenceId: args.referenceId,
    grossUsd: args.grossUsd,
    costUsd,
    operatorUserId,
    description: `Inference: ${args.model}`,
  })

  return {
    applied: true,
    split,
    operatorUserId,
    costUsd,
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
