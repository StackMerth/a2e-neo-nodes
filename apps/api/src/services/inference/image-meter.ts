/**
 * Track 5 / E3.2 — image generation meter.
 *
 * Per-call meter for /v1/images/generations. Image models bill per
 * image (count × size × quality multiplier) instead of per token, so
 * the chat-completions meter doesn't fit naturally. The route
 * computes the exact cost from the model's pricing table BEFORE the
 * upstream call (allowing a 402 pre-check on insufficient balance);
 * this meter just records that cost atomically with the TokenUsage
 * row.
 *
 * Same idempotency / atomicity / kill-switch contract as
 * meterInferenceCall:
 *   - Atomic prisma.$transaction wraps TokenUsage.create +
 *     debitBalanceInTx so either both land or neither does.
 *   - InsufficientBalanceError throws + rolls back if the buyer's
 *     balance moved between the route's pre-check and now.
 *   - DuplicateTransactionError (via the balance ledger's
 *     (type, referenceId) unique) catches double-meter races.
 *   - When REVENUE_SPLIT_ENABLED is on, creditInferenceCall fires
 *     after the transaction commits so the 3-way split flows through
 *     the same revenue/share infrastructure as chat completions.
 *
 * Same TokenUsage row shape: inputTokens carries the image count
 * (good enough for analytics — "how many images did this buyer
 * generate?"), outputTokens stays 0 (no completion tokens for
 * images), costUsd is the exact total charged. The aggregator and
 * invoice rollups treat it identically to a chat call.
 */

import type { PrismaClient } from '@a2e/database'
import { debitBalanceInTx, InsufficientBalanceError } from '../balance/balance-service.js'
import { creditInferenceCall } from '../revenue/inference-credit.js'

export interface ImageMeterArgs {
  userId: string
  apiKeyId: string
  model: string
  /** Number of images generated. Stored on TokenUsage.inputTokens for analytics. */
  imageCount: number
  /** Pre-computed total cost in USD. Charged exactly. */
  costUsd: number
  /** Stable identifier for idempotency. Pass the InferenceRequest id. */
  referenceId: string
  /** Operator node id when an operator worker served the call. */
  operatorId?: string | null
  /** Wall-clock latency from route start to upstream close. */
  latencyMs?: number | null
}

export interface ImageMeterResult {
  costUsd: number
  imageCount: number
  model: string
  referenceId: string
}

export async function meterImageCall(
  prisma: PrismaClient,
  args: ImageMeterArgs,
): Promise<ImageMeterResult> {
  // Free-tier or zero-cost models still get a TokenUsage row for
  // observability, just no ledger debit. Matches meterInferenceCall's
  // no-cost branch behavior.
  const isNoCost = args.costUsd <= 0

  await prisma.$transaction(async (tx) => {
    await tx.tokenUsage.create({
      data: {
        apiKeyId: args.apiKeyId,
        userId: args.userId,
        requestId: args.referenceId,
        model: args.model,
        inputTokens: args.imageCount,
        outputTokens: 0,
        costUsd: args.costUsd,
        operatorId: args.operatorId ?? null,
        latencyMs: args.latencyMs ?? null,
      },
    })

    if (!isNoCost) {
      // debitBalanceInTx throws InsufficientBalanceError if short — the
      // parent transaction rolls back the TokenUsage insert so we
      // never store a usage row without a matching ledger entry.
      await debitBalanceInTx(tx, {
        userId: args.userId,
        amountUsd: args.costUsd,
        // Same ledger type as chat completions / embeddings — image
        // inference is just another flavor under SPEND_INFERENCE.
        type: 'SPEND_INFERENCE',
        description: `Image: ${args.model} (${args.imageCount} image${args.imageCount === 1 ? '' : 's'})`,
        referenceId: args.referenceId,
      })
    }
  })

  // Same M1.1 split as chat completions — fires after the transaction
  // commits so a split failure can never break the billing path the
  // buyer has already paid through. No-op when REVENUE_SPLIT_ENABLED
  // is false (current production default).
  if (!isNoCost) {
    try {
      await creditInferenceCall(prisma, {
        referenceId: args.referenceId,
        grossUsd: args.costUsd,
        operatorNodeId: args.operatorId ?? null,
        model: args.model,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[image-meter] split failed for ${args.referenceId}:`, err)
    }
  }

  return {
    costUsd: args.costUsd,
    imageCount: args.imageCount,
    model: args.model,
    referenceId: args.referenceId,
  }
}

// Re-export so route handlers can catch the typed error without
// importing balance-service directly.
export { InsufficientBalanceError }
