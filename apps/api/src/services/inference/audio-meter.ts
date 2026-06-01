/**
 * Track 5 / E3.3 — audio transcription meter.
 *
 * Per-call meter for /v1/audio/transcriptions. Whisper-family models
 * bill per second of audio input (OpenAI: $0.006/min = $0.0001/sec).
 * The route can only compute the exact cost AFTER the upstream returns
 * (we don't know the audio duration until the transcriber reports it),
 * so unlike images this meter never sees a pre-checked cost — it
 * receives the durationSeconds and per-second price and computes the
 * total in-flight.
 *
 * Same idempotency / atomicity / kill-switch contract as the chat and
 * image meters:
 *   - Atomic prisma.$transaction wraps TokenUsage.create +
 *     debitBalanceInTx so either both land or neither does.
 *   - InsufficientBalanceError throws + rolls back if the buyer's
 *     balance went to zero between the upstream call and now (race).
 *     We can't refund the upstream cost we already paid, so the route
 *     catches + logs this case rather than 402-ing the buyer.
 *   - DuplicateTransactionError (via the balance ledger's
 *     (type, referenceId) unique) catches double-meter races.
 *   - When REVENUE_SPLIT_ENABLED is on, creditInferenceCall fires
 *     after the transaction commits so the 3-way split flows through
 *     the same revenue/share infrastructure as chat completions.
 *
 * TokenUsage row shape: inputTokens carries the audio duration in
 * seconds (rounded to integer for analytics: "how many audio-seconds
 * did this buyer transcribe?"), outputTokens stays 0. costUsd is the
 * exact total charged. The aggregator + invoice rollups treat audio
 * calls identically to chat / image calls under SPEND_INFERENCE.
 */

import type { PrismaClient } from '@a2e/database'
import { debitBalanceInTx, InsufficientBalanceError } from '../balance/balance-service.js'
import { creditInferenceCall } from '../revenue/inference-credit.js'

export interface AudioMeterArgs {
  userId: string
  apiKeyId: string
  model: string
  /** Audio duration in seconds (float — Whisper reports fractional). */
  durationSeconds: number
  /** Pre-computed total cost in USD. Charged exactly. */
  costUsd: number
  /** Stable identifier for idempotency. Pass the InferenceRequest id. */
  referenceId: string
  /** Operator node id when an operator worker served the call. */
  operatorId?: string | null
  /** Wall-clock latency from route start to upstream close. */
  latencyMs?: number | null
}

export interface AudioMeterResult {
  costUsd: number
  durationSeconds: number
  model: string
  referenceId: string
}

export async function meterAudioCall(
  prisma: PrismaClient,
  args: AudioMeterArgs,
): Promise<AudioMeterResult> {
  const isNoCost = args.costUsd <= 0
  // Round duration to whole seconds for the TokenUsage analytics
  // column. The exact cost was already computed with full precision;
  // this only affects the "how many audio-seconds did this buyer
  // transcribe" rollup.
  const durationSecondsInt = Math.max(0, Math.round(args.durationSeconds))

  await prisma.$transaction(async (tx) => {
    await tx.tokenUsage.create({
      data: {
        apiKeyId: args.apiKeyId,
        userId: args.userId,
        requestId: args.referenceId,
        model: args.model,
        inputTokens: durationSecondsInt,
        outputTokens: 0,
        costUsd: args.costUsd,
        operatorId: args.operatorId ?? null,
        latencyMs: args.latencyMs ?? null,
      },
    })

    if (!isNoCost) {
      await debitBalanceInTx(tx, {
        userId: args.userId,
        amountUsd: args.costUsd,
        type: 'SPEND_INFERENCE',
        description: `Audio: ${args.model} (${durationSecondsInt}s)`,
        referenceId: args.referenceId,
      })
    }
  })

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
      console.error(`[audio-meter] split failed for ${args.referenceId}:`, err)
    }
  }

  return {
    costUsd: args.costUsd,
    durationSeconds: args.durationSeconds,
    model: args.model,
    referenceId: args.referenceId,
  }
}

export { InsufficientBalanceError }
