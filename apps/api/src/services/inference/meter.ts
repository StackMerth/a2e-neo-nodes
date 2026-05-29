/**
 * Track 5 / 3.A — per-call inference meter.
 *
 * The single point where an inference call becomes both a balance
 * debit and a TokenUsage row. Called once per request, normally at
 * the moment the SSE stream closes (so the meter sees the final
 * token counts whether they came from the worker's reported usage
 * or the local fallback tokenizer).
 *
 * Idempotency contract: callers must pass a stable referenceId
 * (typically the inference request id). The balance ledger's unique
 * (type, referenceId) constraint guarantees a retry produces the
 * same end state without double-debit. The TokenUsage row uses
 * `referenceId` as the inserted requestId and is keyed by cuid, so
 * a duplicate emission produces a second TokenUsage row with the
 * same requestId — the usage-aggregator deduplicates by
 * (requestId, model) when rolling into invoices.
 *
 * Pricing lookup: every call hits ModelPricing.findUnique on the
 * model id. Cheap and avoids stale-cache problems if pricing is
 * updated mid-day. If we ever care, a one-line in-memory cache with
 * a 60s TTL can be added in front; right now the call rate doesn't
 * justify it.
 *
 * Error handling: a meter failure (unknown model, insufficient
 * balance, ledger duplicate) must NOT silently swallow the call.
 * The caller (gateway endpoint) needs to know so it can either
 * surface the error to the buyer (insufficient balance => 402) or
 * fail safe by stopping the response stream. Meter therefore throws
 * typed errors rather than returning null.
 */

import type { PrismaClient } from '@a2e/database'
import { debitBalance, InsufficientBalanceError } from '../balance/balance-service.js'

export class UnknownModelError extends Error {
  constructor(public modelId: string) {
    super(`No active pricing for model "${modelId}". Add a ModelPricing row before metering calls.`)
    this.name = 'UnknownModelError'
  }
}

export interface MeterArgs {
  // The buyer whose balance is being debited. Resolved from the
  // ApiKey at the gateway before this is called.
  userId: string
  apiKeyId: string
  // Pricing key — must match an active ModelPricing.modelId row.
  model: string
  // Token counts. Prefer worker-reported counts (vLLM/TGI emit
  // usage.prompt_tokens / completion_tokens); fall back to the
  // tokenizer service when the worker can't report (stream cancel,
  // older worker version).
  inputTokens: number
  outputTokens: number
  // Stable identifier for this call so the balance ledger + usage
  // row stay correlated and retries are idempotent.
  referenceId: string
  // Optional fields populated when 3.B lands and we have a real
  // routing layer. Null in 3.A test/dev mode.
  operatorId?: string | null
  latencyMs?: number | null
}

export interface MeterResult {
  costUsd: number
  inputTokens: number
  outputTokens: number
  // Echoed back for the caller's response body / logs.
  model: string
  referenceId: string
}

/**
 * Compute cost, persist the usage row, debit the buyer's balance,
 * and return the meter result. All-or-nothing: if the debit fails,
 * the TokenUsage row is rolled back so we never have a usage
 * record without a matching ledger entry (which would corrupt the
 * monthly invoice).
 *
 * Throws:
 *   - UnknownModelError when no active ModelPricing matches
 *   - InsufficientBalanceError when buyer balance is short
 *   - any underlying Prisma error on connection failure
 */
export async function meterInferenceCall(
  prisma: PrismaClient,
  args: MeterArgs,
): Promise<MeterResult> {
  const pricing = await prisma.modelPricing.findUnique({
    where: { modelId: args.model },
  })
  if (!pricing || !pricing.isActive) {
    throw new UnknownModelError(args.model)
  }

  // Per-million pricing → per-token cost. Two-stage cents-style
  // rounding would be premature optimisation; Float through to four
  // decimal places matches how SPEND_RENTAL stores micro-costs and
  // keeps reconciliation arithmetic simple.
  const inputCost = (args.inputTokens * pricing.inputPricePerMillionTokens) / 1_000_000
  const outputCost = (args.outputTokens * pricing.outputPricePerMillionTokens) / 1_000_000
  const costUsd = inputCost + outputCost

  // No-cost calls (e.g. a buyer cancelled before any tokens emitted)
  // still get a usage row for observability but skip the ledger
  // debit. The aggregator filters costUsd=0 rows from monthly totals.
  const isNoCost = costUsd <= 0

  await prisma.$transaction(async (tx) => {
    await tx.tokenUsage.create({
      data: {
        apiKeyId: args.apiKeyId,
        userId: args.userId,
        requestId: args.referenceId,
        model: args.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        costUsd,
        operatorId: args.operatorId ?? null,
        latencyMs: args.latencyMs ?? null,
      },
    })

    if (!isNoCost) {
      // debitBalance throws InsufficientBalanceError if short — the
      // transaction wrapper rolls back the TokenUsage insert so we
      // never store a usage row without a matching ledger entry.
      await debitBalance(tx as unknown as PrismaClient, {
        userId: args.userId,
        amountUsd: costUsd,
        type: 'SPEND_INFERENCE',
        description: `Inference: ${args.model} (${args.inputTokens}+${args.outputTokens} tokens)`,
        referenceId: args.referenceId,
      })
    }
  })

  return {
    costUsd,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    model: args.model,
    referenceId: args.referenceId,
  }
}

// Re-export so callers don't have to also import from balance-service
// to handle the insufficient-balance case.
export { InsufficientBalanceError }
