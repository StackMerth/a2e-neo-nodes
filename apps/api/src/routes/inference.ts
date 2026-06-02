/**
 * Track 5 / E2.2 — OpenAI-compatible inference API.
 *
 *   POST /v1/chat/completions    (non-streaming; SSE in E2.3)
 *   GET  /v1/models              (catalogue discovery)
 *
 * Authenticated via buyer API key (a2e-buyer-... in Authorization:
 * Bearer header). Key must carry 'inference:write' permission.
 *
 * Routing decision per request:
 *   1. pickInferenceWorker(model) — if any operator worker matches
 *      and has capacity, route to them (real Track 5 marketplace).
 *   2. Otherwise: resolveExternalProvider(model.metadata) — fall
 *      through to a platform-managed external provider (OpenAI or
 *      OpenAI-compatible). Treasury earns the operator slice per
 *      M1.1.
 *   3. If both miss: 503 model_unavailable.
 *
 * Metering: after the response lands, meterInferenceCall fires the
 * SPEND_INFERENCE debit + creates the TokenUsage row + (if
 * REVENUE_SPLIT_ENABLED) splits the gross 3 ways via M1.1's
 * creditInferenceCall. The InferenceRequest audit row is created
 * before the worker call (status ROUTING -> STREAMING -> COMPLETED)
 * so the lifecycle is visible in admin tooling even if the call
 * fails mid-flight.
 *
 * Token counts: prefer worker-reported usage.prompt_tokens /
 * completion_tokens. Fall back to the local tokenizer (M1.2) when
 * the worker doesn't report (e.g. external provider returned no
 * usage field). Match within ~10% for English; off more for code.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { verifyApiKey } from '../services/apikey/manager.js'
import { pickInferenceWorker } from '../services/inference/router.js'
import { resolveExternalProvider } from '../services/inference/external-providers.js'
import { countRequest } from '../services/inference/tokenizer.js'
import {
  meterInferenceCall,
  UnknownModelError,
  InsufficientBalanceError,
} from '../services/inference/meter.js'
import { meterImageCall } from '../services/inference/image-meter.js'
import { meterAudioCall } from '../services/inference/audio-meter.js'
import {
  callAnthropicChat,
  streamAnthropicChat,
  type OpenAIChatRequest,
} from '../services/inference/anthropic-adapter.js'

// -----------------------------------------------------------------
// E3.1 — embeddings schemas
// -----------------------------------------------------------------

// OpenAI's /v1/embeddings input is permissive: a single string, an
// array of strings (batched), an array of token ids (pre-tokenized),
// or an array of arrays of token ids (batched pre-tokenized). We
// accept all four shapes and pass through to the upstream verbatim.
const embeddingsInputSchema = z.union([
  z.string().max(100000),
  z.array(z.string().max(100000)).max(2048),
  z.array(z.number().int()).max(100000),
  z.array(z.array(z.number().int())).max(2048),
])

const embeddingsRequestSchema = z.object({
  model: z.string().min(1).max(200),
  input: embeddingsInputSchema,
  // OpenAI defaults to float; base64 is denser for large batches.
  // Passthrough — the upstream returns whichever the buyer asked for.
  encoding_format: z.enum(['float', 'base64']).optional(),
  // Reduce output dimensionality (Matryoshka models like
  // text-embedding-3-small/large support this).
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
}).passthrough()

interface EmbeddingsResponse {
  object: 'list'
  data: Array<{
    object: 'embedding'
    embedding: number[] | string
    index: number
  }>
  model: string
  usage?: {
    prompt_tokens?: number
    total_tokens?: number
  }
  [k: string]: unknown
}

// -----------------------------------------------------------------
// E3.2 — image generation schemas
// -----------------------------------------------------------------

// OpenAI's /v1/images/generations shape. Stricter than chat
// completions because pricing depends on size + quality, so we can't
// just passthrough unknown values — we have to know which price
// bucket to charge.
const imagesRequestSchema = z.object({
  model: z.string().min(1).max(200),
  prompt: z.string().min(1).max(8000),
  n: z.number().int().min(1).max(10).optional(),
  // Permissive size: DALL-E sizes ("1024x1024"), gpt-image-1 sizes
  // ("1024x1536"), or any other provider's W x H format.
  size: z.string().regex(/^\d+x\d+$/).optional(),
  // Permissive quality: 'standard' / 'hd' for DALL-E,
  // 'low' / 'medium' / 'high' / 'auto' for gpt-image-1,
  // 'default' for open-source models (SDXL, FLUX). The metadata's
  // imagePricing table is the source of truth for what's actually
  // priced; the route 400s if the (quality, size) combo isn't priced.
  quality: z.string().min(1).max(32).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  // DALL-E 3 only — passed through; other models ignore it.
  style: z.string().min(1).max(32).optional(),
  user: z.string().optional(),
}).passthrough()

interface ImagesResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
  [k: string]: unknown
}

/**
 * Look up the cost for a given (size, quality, n) combo from the
 * model's pricing metadata. Returns null when the combo isn't priced
 * (unknown size, missing quality tier, etc.) so the route can 400
 * with a clean error.
 *
 * Pricing format on ModelPricing.metadata:
 *   {
 *     externalProvider: 'openai',
 *     externalModel: 'dall-e-3',
 *     imagePricing: {
 *       'standard:1024x1024': 0.040,
 *       'hd:1024x1024': 0.080,
 *       ...
 *     },
 *     defaultSize: '1024x1024',
 *     defaultQuality: 'standard'
 *   }
 *
 * Open models without a quality tier can use 'default' as the key
 * prefix: { 'default:1024x1024': 0.005 }.
 */
function resolveImageCost(
  metadata: unknown,
  size: string,
  quality: string,
  n: number,
): { perImageUsd: number; totalUsd: number } | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>
  const pricing = m.imagePricing as Record<string, number> | undefined
  if (!pricing) return null

  const key = `${quality}:${size}`
  let perImage = pricing[key]
  // Fall back to default-quality entry when caller didn't specify
  // a quality (e.g. SDXL models that don't have standard/hd tiers).
  if (typeof perImage !== 'number' && quality !== 'default') {
    perImage = pricing[`default:${size}`]
  }
  if (typeof perImage !== 'number') return null

  return {
    perImageUsd: perImage,
    totalUsd: round8(perImage * n),
  }
}

function defaultImageMetadataValue(metadata: unknown, key: string, fallback: string): string {
  if (!metadata || typeof metadata !== 'object') return fallback
  const m = metadata as Record<string, unknown>
  const v = m[key]
  return typeof v === 'string' ? v : fallback
}

// -----------------------------------------------------------------
// E3.3 — audio pricing
// -----------------------------------------------------------------

/**
 * Whisper-family models bill per second of audio. The pricing block
 * on ModelPricing.metadata is the simplest possible shape:
 *   {
 *     externalProvider: 'openai',
 *     externalModel: 'whisper-1',
 *     audioPricing: { perSecondUsd: 0.0001 }
 *   }
 *
 * Returns null when no audio pricing configured so the route can 400
 * with a clean "model isn't an audio model" error before opening the
 * multipart stream.
 */
function resolveAudioPerSecondPrice(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>
  const audioPricing = m.audioPricing as Record<string, unknown> | undefined
  if (!audioPricing) return null
  const v = audioPricing.perSecondUsd
  return typeof v === 'number' && v > 0 ? v : null
}

// OpenAI's /v1/audio/transcriptions form fields. The file itself is
// validated separately via request.file() — this schema covers the
// non-file form fields we forward.
const audioTranscriptionFormSchema = z.object({
  model: z.string().min(1).max(200),
  language: z.string().min(2).max(8).optional(),
  prompt: z.string().max(8000).optional(),
  response_format: z.enum(['json', 'text', 'srt', 'verbose_json', 'vtt']).optional(),
  temperature: z.coerce.number().min(0).max(1).optional(),
}).passthrough()

interface VerboseTranscriptionResponse {
  text: string
  duration?: number
  language?: string
  segments?: Array<{ id: number; start: number; end: number; text: string }>
  [k: string]: unknown
}

// OpenAI-style message shape. Content is either a plain string OR an
// array of parts (for multimodal — vision images, audio). For E2.2
// we only forward what we receive; we don't introspect or transform.
const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).nullable(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
})

const chatCompletionRequestSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema).min(1).max(2000),
  max_tokens: z.number().int().min(1).max(128000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  // For E2.2 stream is forced false; the handler 400s if true.
  // E2.3 wires this to the SSE path.
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().optional(),
  // Permissive on unknown fields — passthrough lets buyers use
  // worker-specific extensions without us needing to track every
  // option Anyscale / Together / OpenAI add.
}).passthrough()

interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: string; content: string | null; [k: string]: unknown }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  [k: string]: unknown
}

export async function inferenceRoutes(fastify: FastifyInstance) {
  // -----------------------------------------------------------------
  // GET /v1/models — catalogue
  // -----------------------------------------------------------------
  fastify.get('/v1/models', async (request, reply) => {
    const auth = await authenticateInferenceCall(request, reply)
    if (!auth) return // reply already sent

    const models = await fastify.prisma.modelPricing.findMany({
      where: { isActive: true },
      orderBy: { modelId: 'asc' },
    })

    // OpenAI's GET /v1/models response shape.
    reply.send({
      object: 'list',
      data: models.map((m) => ({
        id: m.modelId,
        object: 'model',
        created: Math.floor(m.createdAt.getTime() / 1000),
        owned_by: 'tokenosdeai',
        // Non-standard fields — buyers / SDKs ignore them, but our
        // own portal uses them for the price column on the catalog.
        pricing: {
          input_per_million_tokens: m.inputPricePerMillionTokens,
          output_per_million_tokens: m.outputPricePerMillionTokens,
        },
      })),
    })
  })

  // -----------------------------------------------------------------
  // POST /v1/chat/completions
  // -----------------------------------------------------------------
  fastify.post('/v1/chat/completions', async (request, reply) => {
    const auth = await authenticateInferenceCall(request, reply)
    if (!auth) return

    const parsed = chatCompletionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          type: 'invalid_request_error',
        },
      })
    }

    // Pricing must exist before we route — the meter rejects unknown
    // models anyway, but checking here lets us 400 cleanly before
    // spending compute on the worker.
    const pricing = await fastify.prisma.modelPricing.findUnique({
      where: { modelId: parsed.data.model },
    })
    if (!pricing || !pricing.isActive) {
      return reply.code(400).send({
        error: {
          message: `Unknown model: ${parsed.data.model}. List available models via GET /v1/models.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      })
    }

    // E2.3: streaming path splits off here. SSE has a fundamentally
    // different response lifecycle (raw writes vs. send()) so it gets
    // its own handler function. Non-streaming continues below.
    if (parsed.data.stream === true) {
      return handleStreamingChat(fastify, request, reply, auth, parsed.data, pricing)
    }

    // Audit row created up front in ROUTING state. The whole call
    // funnels through it; status flips through STREAMING -> COMPLETED
    // (or FAILED) so admin / forensics can see exactly where any
    // failed call broke.
    const inferenceRequest = await fastify.prisma.inferenceRequest.create({
      data: {
        apiKeyId: auth.keyId,
        userId: auth.userId,
        model: parsed.data.model,
        status: 'ROUTING',
      },
      select: { id: true },
    })

    const startedAt = Date.now()
    let operatorNodeId: string | null = null

    try {
      const worker = await pickInferenceWorker(fastify.prisma, { model: parsed.data.model })

      let upstreamResult: UpstreamResult
      if (worker) {
        operatorNodeId = worker.nodeId
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { inferenceWorkerId: worker.id, status: 'STREAMING' },
        })
        upstreamResult = await callOperatorWorker(worker.baseUrl, parsed.data, request.body)
      } else {
        const external = resolveExternalProvider(pricing.metadata)
        if (!external) {
          await fastify.prisma.inferenceRequest.update({
            where: { id: inferenceRequest.id },
            data: { status: 'FAILED', errorMessage: 'No worker and no external fallback configured', completedAt: new Date() },
          })
          return reply.code(503).send({
            error: {
              message: `Model "${parsed.data.model}" temporarily unavailable: no operator workers online and no external fallback configured.`,
              type: 'server_error',
              code: 'model_unavailable',
            },
          })
        }
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { externalProvider: external.kind, status: 'STREAMING' },
        })
        upstreamResult = await callExternalProvider(external, parsed.data, request.body)
      }

      const latencyMs = Date.now() - startedAt

      // Resolve token counts: prefer upstream's, fall back to local
      // tokenizer (M1.2). Local count is a fallback only.
      let inputTokens = upstreamResult.body.usage?.prompt_tokens
      let outputTokens = upstreamResult.body.usage?.completion_tokens
      if (inputTokens == null || outputTokens == null) {
        const promptText = parsed.data.messages
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n')
        const responseText = upstreamResult.body.choices?.[0]?.message?.content ?? ''
        const counted = countRequest(parsed.data.model, promptText, typeof responseText === 'string' ? responseText : '')
        inputTokens ??= counted.inputTokens
        outputTokens ??= counted.outputTokens
      }

      // Meter — debits buyer, creates TokenUsage row, fires
      // creditInferenceCall (M1.1) for the 3-way split if the kill
      // switch is on. Wrapped so meter failure doesn't lose the
      // upstream response we already paid for.
      try {
        await meterInferenceCall(fastify.prisma, {
          userId: auth.userId,
          apiKeyId: auth.keyId,
          model: parsed.data.model,
          inputTokens,
          outputTokens,
          referenceId: inferenceRequest.id,
          operatorId: operatorNodeId,
          latencyMs,
        })
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          // The buyer just consumed compute we now can't bill. Mark
          // the request FAILED with a clear reason; the upstream
          // response is still returned (buyer got their answer) but
          // the next request from them will 402.
          await fastify.prisma.inferenceRequest.update({
            where: { id: inferenceRequest.id },
            data: { status: 'FAILED', errorMessage: 'Insufficient balance — call served but unbillable', completedAt: new Date() },
          }).catch(() => undefined)
          fastify.log.error({ err, requestId: inferenceRequest.id, userId: auth.userId }, 'inference call unbillable')
        } else if (err instanceof UnknownModelError) {
          // We checked the model exists above; this would be a race
          // where pricing was deactivated between our check and the
          // meter call. Log + surface a usable response.
          fastify.log.warn({ err, requestId: inferenceRequest.id }, 'model pricing dropped mid-call')
        } else {
          fastify.log.error({ err, requestId: inferenceRequest.id }, 'meter call failed unexpectedly')
        }
      }

      // Close the audit row.
      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: {
          status: 'COMPLETED',
          inputTokens,
          outputTokens,
          latencyMs,
          // costUsd mirrors what the meter computed; recompute here
          // for the audit row so a meter race doesn't leave costUsd
          // null on an otherwise-successful row.
          // 8 decimal places — inference calls bill at fractions of a
          // cent (a 100-token call to llama-3.3 is ~$0.00006). round4
          // was crushing the audit cost to $0 even when the meter
          // charged the correct amount.
          costUsd: round8(
            (inputTokens * pricing.inputPricePerMillionTokens + outputTokens * pricing.outputPricePerMillionTokens) / 1_000_000,
          ),
          completedAt: new Date(),
        },
      })

      // Stamp the response with our inference id so the buyer can
      // correlate it with our audit log when filing support tickets.
      const body = { ...upstreamResult.body, id: upstreamResult.body.id ?? `chatcmpl-${inferenceRequest.id}` }
      reply.code(200).send(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      fastify.log.error({ err, requestId: inferenceRequest.id }, 'inference call failed')
      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
      }).catch(() => undefined)
      reply.code(502).send({
        error: {
          message: `Upstream inference failed: ${message}`,
          type: 'server_error',
          code: 'upstream_failure',
        },
      })
    }
  })

  // -----------------------------------------------------------------
  // E3.1 — POST /v1/embeddings
  // -----------------------------------------------------------------
  fastify.post('/v1/embeddings', async (request, reply) => {
    const auth = await authenticateInferenceCall(request, reply)
    if (!auth) return

    const parsed = embeddingsRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          type: 'invalid_request_error',
        },
      })
    }

    const pricing = await fastify.prisma.modelPricing.findUnique({
      where: { modelId: parsed.data.model },
    })
    if (!pricing || !pricing.isActive) {
      return reply.code(400).send({
        error: {
          message: `Unknown model: ${parsed.data.model}. List available models via GET /v1/models.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      })
    }

    // Same audit pattern as chat completions — the request is tracked
    // through ROUTING -> STREAMING -> COMPLETED even though embeddings
    // don't actually stream. STREAMING is just our "upstream is in
    // flight" lifecycle marker.
    const inferenceRequest = await fastify.prisma.inferenceRequest.create({
      data: {
        apiKeyId: auth.keyId,
        userId: auth.userId,
        model: parsed.data.model,
        status: 'ROUTING',
      },
      select: { id: true },
    })

    const startedAt = Date.now()
    let operatorNodeId: string | null = null

    try {
      const worker = await pickInferenceWorker(fastify.prisma, { model: parsed.data.model })

      let upstreamBody: EmbeddingsResponse
      if (worker) {
        operatorNodeId = worker.nodeId
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { inferenceWorkerId: worker.id, status: 'STREAMING' },
        })
        const res = await fetch(`${worker.baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`worker ${res.status}: ${text.slice(0, 200)}`)
        }
        upstreamBody = await res.json() as EmbeddingsResponse
      } else {
        const external = resolveExternalProvider(pricing.metadata)
        if (!external) {
          await fastify.prisma.inferenceRequest.update({
            where: { id: inferenceRequest.id },
            data: { status: 'FAILED', errorMessage: 'No worker and no external fallback configured', completedAt: new Date() },
          })
          return reply.code(503).send({
            error: {
              message: `Model "${parsed.data.model}" temporarily unavailable: no operator workers online and no external fallback configured.`,
              type: 'server_error',
              code: 'model_unavailable',
            },
          })
        }
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { externalProvider: external.kind, status: 'STREAMING' },
        })
        const upstreamReqBody = { ...(request.body as Record<string, unknown>), model: external.externalModel }
        const res = await fetch(`${external.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${external.apiKey}`,
          },
          body: JSON.stringify(upstreamReqBody),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`external (${external.kind}) ${res.status}: ${text.slice(0, 200)}`)
        }
        upstreamBody = await res.json() as EmbeddingsResponse
        // Map the model id back so the buyer sees what they requested.
        upstreamBody.model = parsed.data.model
      }

      const latencyMs = Date.now() - startedAt

      // Token counts: prefer upstream's usage.prompt_tokens. Fall back
      // to the local tokenizer over the concatenated input text. Note
      // pre-tokenized inputs (number arrays) skip the local count
      // since the upstream definitively knows the count there.
      let inputTokens = upstreamBody.usage?.prompt_tokens
      if (inputTokens == null) {
        const input = parsed.data.input
        let text = ''
        if (typeof input === 'string') text = input
        else if (Array.isArray(input) && input.every((x) => typeof x === 'string')) {
          text = (input as string[]).join('\n')
        }
        if (text) {
          const counted = countRequest(parsed.data.model, text, '')
          inputTokens = counted.inputTokens
        } else {
          // Pre-tokenized input — just trust the array length.
          inputTokens = Array.isArray(input)
            ? input.flat(Infinity).length
            : 0
        }
      }
      // Embeddings have no completion tokens; the meter expects both
      // halves but a zero is fine — costUsd math zeros out the output
      // half regardless of outputPricePerMillionTokens.
      const outputTokens = 0

      // Meter — same call site as chat completions. Embeddings only
      // bill on input tokens.
      try {
        await meterInferenceCall(fastify.prisma, {
          userId: auth.userId,
          apiKeyId: auth.keyId,
          model: parsed.data.model,
          inputTokens,
          outputTokens,
          referenceId: inferenceRequest.id,
          operatorId: operatorNodeId,
          latencyMs,
        })
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await fastify.prisma.inferenceRequest.update({
            where: { id: inferenceRequest.id },
            data: { status: 'FAILED', errorMessage: 'Insufficient balance — call served but unbillable', completedAt: new Date() },
          }).catch(() => undefined)
          fastify.log.error({ err, requestId: inferenceRequest.id, userId: auth.userId }, 'embeddings call unbillable')
        } else if (!(err instanceof UnknownModelError)) {
          fastify.log.error({ err, requestId: inferenceRequest.id }, 'embeddings meter call failed')
        }
      }

      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: {
          status: 'COMPLETED',
          inputTokens,
          outputTokens,
          latencyMs,
          costUsd: round8(
            (inputTokens * pricing.inputPricePerMillionTokens) / 1_000_000,
          ),
          completedAt: new Date(),
        },
      })

      reply.code(200).send(upstreamBody)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      fastify.log.error({ err, requestId: inferenceRequest.id }, 'embeddings call failed')
      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
      }).catch(() => undefined)
      reply.code(502).send({
        error: {
          message: `Upstream embeddings failed: ${message}`,
          type: 'server_error',
          code: 'upstream_failure',
        },
      })
    }
  })

  // -----------------------------------------------------------------
  // E3.2 — POST /v1/images/generations
  // -----------------------------------------------------------------
  fastify.post('/v1/images/generations', async (request, reply) => {
    const auth = await authenticateInferenceCall(request, reply)
    if (!auth) return

    const parsed = imagesRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          type: 'invalid_request_error',
        },
      })
    }

    const pricing = await fastify.prisma.modelPricing.findUnique({
      where: { modelId: parsed.data.model },
    })
    if (!pricing || !pricing.isActive) {
      return reply.code(400).send({
        error: {
          message: `Unknown model: ${parsed.data.model}. List available models via GET /v1/models.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      })
    }

    const size = parsed.data.size ?? defaultImageMetadataValue(pricing.metadata, 'defaultSize', '1024x1024')
    const quality = parsed.data.quality ?? defaultImageMetadataValue(pricing.metadata, 'defaultQuality', 'standard')
    const n = parsed.data.n ?? 1

    // Compute cost up front so the buyer's balance is pre-checked
    // before we spend any compute. Images aren't sub-cent like
    // embeddings; a buyer accidentally requesting 10 hd images at
    // $0.12 each ($1.20) should fail cleanly if their balance is
    // empty rather than after the upstream charge.
    const costResolution = resolveImageCost(pricing.metadata, size, quality, n)
    if (!costResolution) {
      return reply.code(400).send({
        error: {
          message: `Model "${parsed.data.model}" doesn't have pricing configured for quality="${quality}" size="${size}". Try a different combination or check GET /v1/models.`,
          type: 'invalid_request_error',
          code: 'unsupported_image_options',
        },
      })
    }

    // Insufficient balance pre-check. 402 is the standard "you need
    // to pay before we serve you" status code; OpenAI returns the
    // same shape on their out-of-credit case.
    const balanceRow = await fastify.prisma.buyerBalance.findUnique({
      where: { userId: auth.userId },
      select: { balanceUsd: true },
    })
    const currentBalance = balanceRow?.balanceUsd ?? 0
    if (currentBalance < costResolution.totalUsd) {
      return reply.code(402).send({
        error: {
          message: `Insufficient balance. This call costs $${costResolution.totalUsd.toFixed(4)} (${n} image${n === 1 ? '' : 's'} at $${costResolution.perImageUsd.toFixed(4)} each); balance is $${currentBalance.toFixed(4)}. Top up via /buyer/balance.`,
          type: 'insufficient_balance',
          code: 'insufficient_balance',
        },
      })
    }

    const inferenceRequest = await fastify.prisma.inferenceRequest.create({
      data: {
        apiKeyId: auth.keyId,
        userId: auth.userId,
        model: parsed.data.model,
        status: 'ROUTING',
      },
      select: { id: true },
    })

    const startedAt = Date.now()
    let operatorNodeId: string | null = null

    try {
      const worker = await pickInferenceWorker(fastify.prisma, { model: parsed.data.model })

      let upstreamBody: ImagesResponse
      if (worker) {
        operatorNodeId = worker.nodeId
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { inferenceWorkerId: worker.id, status: 'STREAMING' },
        })
        const res = await fetch(`${worker.baseUrl}/v1/images/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`worker ${res.status}: ${text.slice(0, 200)}`)
        }
        upstreamBody = await res.json() as ImagesResponse
      } else {
        const external = resolveExternalProvider(pricing.metadata)
        if (!external) {
          await fastify.prisma.inferenceRequest.update({
            where: { id: inferenceRequest.id },
            data: { status: 'FAILED', errorMessage: 'No worker and no external fallback configured', completedAt: new Date() },
          })
          return reply.code(503).send({
            error: {
              message: `Model "${parsed.data.model}" temporarily unavailable.`,
              type: 'server_error',
              code: 'model_unavailable',
            },
          })
        }
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { externalProvider: external.kind, status: 'STREAMING' },
        })
        const upstreamReqBody = {
          ...(request.body as Record<string, unknown>),
          model: external.externalModel,
        }
        const res = await fetch(`${external.baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${external.apiKey}`,
          },
          body: JSON.stringify(upstreamReqBody),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`external (${external.kind}) ${res.status}: ${text.slice(0, 200)}`)
        }
        upstreamBody = await res.json() as ImagesResponse
      }

      const latencyMs = Date.now() - startedAt

      // Meter with the pre-computed cost. The image-meter helper
      // handles the atomic TokenUsage + balance debit + revenue split.
      try {
        await meterImageCall(fastify.prisma, {
          userId: auth.userId,
          apiKeyId: auth.keyId,
          model: parsed.data.model,
          imageCount: n,
          costUsd: costResolution.totalUsd,
          referenceId: inferenceRequest.id,
          operatorId: operatorNodeId,
          latencyMs,
        })
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          // Race against another concurrent call drained the balance
          // between our pre-check and the debit. Buyer got their
          // images; we eat this one and log.
          fastify.log.error({ err, requestId: inferenceRequest.id, userId: auth.userId }, 'image call unbillable (raced balance pre-check)')
        } else if (!(err instanceof UnknownModelError)) {
          fastify.log.error({ err, requestId: inferenceRequest.id }, 'image meter call failed')
        }
      }

      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: {
          status: 'COMPLETED',
          inputTokens: n,
          outputTokens: 0,
          latencyMs,
          costUsd: costResolution.totalUsd,
          completedAt: new Date(),
        },
      })

      reply.code(200).send(upstreamBody)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      fastify.log.error({ err, requestId: inferenceRequest.id }, 'image generation call failed')
      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
      }).catch(() => undefined)
      reply.code(502).send({
        error: {
          message: `Upstream image generation failed: ${message}`,
          type: 'server_error',
          code: 'upstream_failure',
        },
      })
    }
  })

  // -----------------------------------------------------------------
  // E3.3 — POST /v1/audio/transcriptions
  // -----------------------------------------------------------------
  //
  // OpenAI-compatible Whisper endpoint. Accepts multipart/form-data
  // with a `file` field (audio bytes) and form fields for model,
  // language, prompt, response_format, temperature.
  //
  // Billing: per second of audio duration. We can't pre-check the
  // cost because the duration is only known after the upstream
  // transcribes. Mitigation: cap upload at 25 MB (matches OpenAI's
  // limit), so even at the highest realistic audio bitrate the
  // worst-case cost is bounded (~25 min audio at $0.0001/sec =
  // $0.15). A buyer with $0 balance and a 25-min upload eats us
  // $0.15 once per race; the route logs + carries on.
  //
  // Routing: operator worker first, then external provider fallback.
  // Same audit-row lifecycle as chat / embeddings / images. Worker
  // handles multipart via the same route on its side.
  //
  // Response: we ALWAYS request verbose_json upstream (so we get the
  // duration), then translate the response back to whatever
  // response_format the buyer asked for. For 'text' / 'srt' / 'vtt',
  // we make a second upstream call in the buyer's requested format
  // and use the duration from the first call.
  //   Trade-off: an extra call for non-json formats vs. forcing
  //   verbose_json upstream and translating client-side. The extra
  //   call is simpler and bounded by the operator's own latency.
  fastify.post('/v1/audio/transcriptions', async (request, reply) => {
    const auth = await authenticateInferenceCall(request, reply)
    if (!auth) return

    // Multipart guard. request.isMultipart() returns false for
    // application/json or wrong Content-Type — surface a clean 400
    // instead of letting multipart throw deep in the parser.
    if (!request.isMultipart()) {
      return reply.code(400).send({
        error: {
          message: 'Expected multipart/form-data. POST the audio file as `file` plus a `model` field, e.g. `curl -F file=@audio.mp3 -F model=whisper-1`.',
          type: 'invalid_request_error',
          code: 'expected_multipart',
        },
      })
    }

    // Drain multipart: pull every part. The file part is buffered to
    // memory (bounded by the 25 MB plugin limit). Form fields go into
    // a plain object so we can validate them with zod.
    let fileBuffer: Buffer | null = null
    let fileMime: string | null = null
    let fileName: string | null = null
    const fields: Record<string, string> = {}
    try {
      const parts = request.parts()
      for await (const part of parts) {
        if (part.type === 'file') {
          // First file wins — the multipart plugin's `files: 1` limit
          // means a second one would have errored already.
          fileBuffer = await part.toBuffer()
          fileMime = part.mimetype ?? 'application/octet-stream'
          fileName = part.filename ?? 'audio.bin'
        } else {
          fields[part.fieldname] = (part as { value: unknown }).value as string
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'multipart parse failed'
      // File too large is the common failure mode; map it to 413.
      const isSize = /file too large|too big|size limit/i.test(message)
      return reply.code(isSize ? 413 : 400).send({
        error: {
          message: isSize
            ? `Audio file exceeds the 25 MB upload limit. Split the audio or use a smaller bitrate.`
            : `Could not parse multipart body: ${message}`,
          type: 'invalid_request_error',
          code: isSize ? 'file_too_large' : 'invalid_multipart',
        },
      })
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return reply.code(400).send({
        error: {
          message: 'Missing required form field `file` (the audio to transcribe).',
          type: 'invalid_request_error',
          code: 'missing_file',
        },
      })
    }

    const parsed = audioTranscriptionFormSchema.safeParse(fields)
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          type: 'invalid_request_error',
        },
      })
    }

    const pricing = await fastify.prisma.modelPricing.findUnique({
      where: { modelId: parsed.data.model },
    })
    if (!pricing || !pricing.isActive) {
      return reply.code(400).send({
        error: {
          message: `Unknown model: ${parsed.data.model}. List available models via GET /v1/models.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      })
    }

    const perSecondPrice = resolveAudioPerSecondPrice(pricing.metadata)
    if (perSecondPrice === null) {
      return reply.code(400).send({
        error: {
          message: `Model "${parsed.data.model}" is not configured for audio transcription. Use a Whisper-family model.`,
          type: 'invalid_request_error',
          code: 'not_audio_model',
        },
      })
    }

    // Buyer-requested response format (defaults to json per OpenAI).
    const buyerFormat = parsed.data.response_format ?? 'json'

    const inferenceRequest = await fastify.prisma.inferenceRequest.create({
      data: {
        apiKeyId: auth.keyId,
        userId: auth.userId,
        model: parsed.data.model,
        status: 'ROUTING',
      },
      select: { id: true },
    })

    const startedAt = Date.now()
    let operatorNodeId: string | null = null

    try {
      const worker = await pickInferenceWorker(fastify.prisma, { model: parsed.data.model })

      // We always ask upstream for verbose_json so we get a duration
      // back, regardless of what the buyer wanted. If they wanted
      // something else (text/srt/vtt), make a second pass below.
      let upstreamBaseUrl: string
      let upstreamHeaders: Record<string, string>
      let upstreamModelId: string
      if (worker) {
        operatorNodeId = worker.nodeId
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { inferenceWorkerId: worker.id, status: 'STREAMING' },
        })
        upstreamBaseUrl = `${worker.baseUrl}/v1/audio/transcriptions`
        upstreamHeaders = {}
        upstreamModelId = parsed.data.model
      } else {
        const external = resolveExternalProvider(pricing.metadata)
        if (!external) {
          await fastify.prisma.inferenceRequest.update({
            where: { id: inferenceRequest.id },
            data: { status: 'FAILED', errorMessage: 'No worker and no external fallback configured', completedAt: new Date() },
          })
          return reply.code(503).send({
            error: {
              message: `Model "${parsed.data.model}" temporarily unavailable.`,
              type: 'server_error',
              code: 'model_unavailable',
            },
          })
        }
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { externalProvider: external.kind, status: 'STREAMING' },
        })
        upstreamBaseUrl = `${external.baseUrl}/audio/transcriptions`
        upstreamHeaders = { Authorization: `Bearer ${external.apiKey}` }
        upstreamModelId = external.externalModel
      }

      // Build the upstream multipart form. Node 20's native FormData
      // + Blob handles this without any extra dep — fetch sets the
      // boundary header automatically.
      // Capture in a const so TypeScript narrows away the null type
      // inside the closure (the route's outer null-check already
      // guarantees this, but TS doesn't track through the lambda).
      const fileBytes = new Uint8Array(fileBuffer)
      const buildForm = (responseFormat: string): FormData => {
        const f = new FormData()
        f.append('file', new Blob([fileBytes], { type: fileMime ?? 'application/octet-stream' }), fileName ?? 'audio.bin')
        f.append('model', upstreamModelId)
        f.append('response_format', responseFormat)
        if (parsed.data.language) f.append('language', parsed.data.language)
        if (parsed.data.prompt) f.append('prompt', parsed.data.prompt)
        if (parsed.data.temperature !== undefined) f.append('temperature', String(parsed.data.temperature))
        return f
      }

      // First (and possibly only) upstream call: verbose_json so we
      // get the duration back.
      const verboseRes = await fetch(upstreamBaseUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: buildForm('verbose_json'),
      })
      if (!verboseRes.ok) {
        const text = await verboseRes.text().catch(() => '')
        throw new Error(`upstream ${verboseRes.status}: ${text.slice(0, 200)}`)
      }
      const verbose = await verboseRes.json() as VerboseTranscriptionResponse
      const durationSeconds = typeof verbose.duration === 'number' && verbose.duration >= 0 ? verbose.duration : 0
      const costUsd = round8(durationSeconds * perSecondPrice)

      // If the buyer asked for verbose_json (or 'json'), we already
      // have what they want — strip the verbose fields for plain json.
      // For text/srt/vtt make a second upstream call.
      let buyerResponse: unknown
      if (buyerFormat === 'verbose_json') {
        buyerResponse = verbose
      } else if (buyerFormat === 'json') {
        buyerResponse = { text: verbose.text }
      } else {
        const formatRes = await fetch(upstreamBaseUrl, {
          method: 'POST',
          headers: upstreamHeaders,
          body: buildForm(buyerFormat),
        })
        if (!formatRes.ok) {
          const text = await formatRes.text().catch(() => '')
          throw new Error(`upstream(${buyerFormat}) ${formatRes.status}: ${text.slice(0, 200)}`)
        }
        buyerResponse = await formatRes.text()
      }

      const latencyMs = Date.now() - startedAt

      try {
        await meterAudioCall(fastify.prisma, {
          userId: auth.userId,
          apiKeyId: auth.keyId,
          model: parsed.data.model,
          durationSeconds,
          costUsd,
          referenceId: inferenceRequest.id,
          operatorId: operatorNodeId,
          latencyMs,
        })
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          fastify.log.error({ err, requestId: inferenceRequest.id, userId: auth.userId }, 'audio call unbillable (insufficient balance after upstream)')
        } else if (!(err instanceof UnknownModelError)) {
          fastify.log.error({ err, requestId: inferenceRequest.id }, 'audio meter call failed')
        }
      }

      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: {
          status: 'COMPLETED',
          inputTokens: Math.max(0, Math.round(durationSeconds)),
          outputTokens: 0,
          latencyMs,
          costUsd,
          completedAt: new Date(),
        },
      })

      // OpenAI returns text/srt/vtt as plain text content type, not
      // JSON. Honour that so SDKs parse correctly.
      if (typeof buyerResponse === 'string') {
        const contentType = buyerFormat === 'srt'
          ? 'application/x-subrip'
          : buyerFormat === 'vtt'
            ? 'text/vtt'
            : 'text/plain'
        reply.header('Content-Type', contentType).code(200).send(buyerResponse)
      } else {
        reply.code(200).send(buyerResponse)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      fastify.log.error({ err, requestId: inferenceRequest.id }, 'audio transcription call failed')
      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
      }).catch(() => undefined)
      reply.code(502).send({
        error: {
          message: `Upstream audio transcription failed: ${message}`,
          type: 'server_error',
          code: 'upstream_failure',
        },
      })
    }
  })
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface AuthResult {
  userId: string
  keyId: string
}

async function authenticateInferenceCall(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthResult | null> {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({
      error: { message: 'Missing Authorization: Bearer <a2e-buyer-...> header', type: 'authentication_error' },
    })
    return null
  }
  const key = auth.slice('Bearer '.length).trim()
  if (!key.startsWith('a2e-buyer-')) {
    reply.code(401).send({
      error: { message: 'Invalid API key format (expected a2e-buyer-...)', type: 'authentication_error' },
    })
    return null
  }
  const verified = await verifyApiKey(key)
  if (!verified) {
    reply.code(401).send({
      error: { message: 'Invalid or revoked API key', type: 'authentication_error' },
    })
    return null
  }
  if (!verified.permissions.includes('inference:write')) {
    reply.code(403).send({
      error: { message: 'API key missing required permission: inference:write', type: 'permission_error' },
    })
    return null
  }
  return { userId: verified.userId, keyId: verified.keyId }
}

interface UpstreamResult {
  body: ChatCompletionResponse
}

async function callOperatorWorker(
  baseUrl: string,
  parsedRequest: z.infer<typeof chatCompletionRequestSchema>,
  rawBody: unknown,
): Promise<UpstreamResult> {
  // Pass the raw body through verbatim so any vendor-specific fields
  // (logit_bias, response_format, tools, etc.) survive untouched.
  // Operator workers (vLLM / SGLang / TGI) accept OpenAI's exact shape.
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rawBody),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`worker ${res.status}: ${text.slice(0, 200)}`)
  }
  const body = await res.json() as ChatCompletionResponse
  return { body }
}

async function callExternalProvider(
  external: ReturnType<typeof resolveExternalProvider>,
  parsedRequest: z.infer<typeof chatCompletionRequestSchema>,
  rawBody: unknown,
): Promise<UpstreamResult> {
  if (!external) throw new Error('external provider config missing')

  // Anthropic uses a different API shape — translate via the adapter.
  // The adapter handles request/response translation so the buyer's
  // OpenAI-shaped request comes back as an OpenAI-shaped response.
  if (external.kind === 'anthropic') {
    const body = await callAnthropicChat(
      rawBody as OpenAIChatRequest,
      external.externalModel,
      external.apiKey,
      parsedRequest.model,
    )
    return { body: body as unknown as ChatCompletionResponse }
  }

  // OpenAI + openai-compat: translate the model id and pass everything
  // else through. The upstream returns OpenAI's exact response shape.
  const upstreamBody = { ...(rawBody as Record<string, unknown>), model: external.externalModel, stream: false }

  const res = await fetch(`${external.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${external.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`external (${external.kind}) ${res.status}: ${text.slice(0, 200)}`)
  }
  const body = await res.json() as ChatCompletionResponse
  // Map the response back to our model id so the buyer sees what
  // they requested, not what we routed under the hood.
  body.model = parsedRequest.model
  return { body }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function round8(n: number): number {
  return Math.round(n * 100000000) / 100000000
}

// ---------------------------------------------------------------------
// E2.3 — SSE streaming handler
// ---------------------------------------------------------------------

/**
 * Streaming variant of /v1/chat/completions. Same routing + audit +
 * metering as the non-streaming path, but the upstream's
 * Server-Sent Events response is proxied chunk-by-chunk to the buyer.
 * Standard OpenAI SDK streaming UX works against this:
 *
 *   client.chat.completions.create(..., stream=True)
 *
 * Flow:
 *   1. Create the InferenceRequest audit row (ROUTING).
 *   2. Pick worker or external provider (same as non-stream path).
 *   3. POST upstream with stream=true.
 *   4. Set Content-Type: text/event-stream on the buyer reply, flush.
 *   5. Pipe upstream's body to the buyer as raw bytes; parse each
 *      SSE chunk to accumulate the response text (for the local
 *      token-count fallback) and to capture the final usage block.
 *   6. On stream close: run the meter (debits buyer, splits revenue),
 *      update the audit row to COMPLETED.
 *
 * SSE format note: OpenAI / Groq / vLLM all emit
 *   data: {"choices":[{"delta":{"content":"chunk"}}], ...}\n\n
 *   ...
 *   data: [DONE]\n\n
 *
 * We pass these through verbatim — no re-encoding, no re-formatting.
 * Token counts come from the final non-[DONE] chunk's usage block
 * when the upstream reports it (Groq/OpenAI do); otherwise the local
 * tokenizer (M1.2) counts the accumulated content.
 */
async function handleStreamingChat(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthResult,
  parsedRequest: z.infer<typeof chatCompletionRequestSchema>,
  pricing: { modelId: string; inputPricePerMillionTokens: number; outputPricePerMillionTokens: number; metadata: unknown },
): Promise<void> {
  const inferenceRequest = await fastify.prisma.inferenceRequest.create({
    data: {
      apiKeyId: auth.keyId,
      userId: auth.userId,
      model: parsedRequest.model,
      status: 'ROUTING',
    },
    select: { id: true },
  })

  const startedAt = Date.now()
  let operatorNodeId: string | null = null

  // Resolve upstream. Same logic as non-stream path. We materialize
  // the upstream HTTP call here so any pre-stream errors (worker
  // refusal, missing fallback) can be reported as a normal JSON
  // error before we commit to SSE.
  const worker = await pickInferenceWorker(fastify.prisma, { model: parsedRequest.model })
  let upstreamRes: Response | null = null
  // Set when routing through the Anthropic adapter (different shape
  // than fetch-based upstream — translates events on our side).
  let anthropicStream: ReturnType<typeof streamAnthropicChat> | null = null

  if (worker) {
    operatorNodeId = worker.nodeId
    await fastify.prisma.inferenceRequest.update({
      where: { id: inferenceRequest.id },
      data: { inferenceWorkerId: worker.id, status: 'STREAMING' },
    })
    upstreamRes = await fetch(`${worker.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(request.body as Record<string, unknown>), stream: true }),
    })
  } else {
    const external = resolveExternalProvider(pricing.metadata)
    if (!external) {
      await fastify.prisma.inferenceRequest.update({
        where: { id: inferenceRequest.id },
        data: { status: 'FAILED', errorMessage: 'No worker and no external fallback configured', completedAt: new Date() },
      })
      reply.code(503).send({
        error: {
          message: `Model "${parsedRequest.model}" temporarily unavailable.`,
          type: 'server_error',
          code: 'model_unavailable',
        },
      })
      return
    }
    await fastify.prisma.inferenceRequest.update({
      where: { id: inferenceRequest.id },
      data: { externalProvider: external.kind, status: 'STREAMING' },
    })
    if (external.kind === 'anthropic') {
      // Anthropic streams have a different event shape than OpenAI's
      // SSE format; the adapter handles the translation and yields
      // ready-to-write OpenAI-format SSE chunks.
      try {
        anthropicStream = streamAnthropicChat(
          request.body as OpenAIChatRequest,
          external.externalModel,
          external.apiKey,
          parsedRequest.model,
        )
      } catch (err) {
        const errMsg = (err as Error).message
        await fastify.prisma.inferenceRequest.update({
          where: { id: inferenceRequest.id },
          data: { status: 'FAILED', errorMessage: errMsg, completedAt: new Date() },
        })
        reply.code(502).send({
          error: { message: errMsg, type: 'server_error', code: 'upstream_failure' },
        })
        return
      }
    } else {
      upstreamRes = await fetch(`${external.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${external.apiKey}`,
        },
        body: JSON.stringify({
          ...(request.body as Record<string, unknown>),
          model: external.externalModel,
          stream: true,
        }),
      })
    }
  }

  // Skip the fetch-ok guard when streaming through Anthropic (the
  // adapter throws on its own upstream failures).
  if (!anthropicStream && (!upstreamRes || !upstreamRes.ok || !upstreamRes.body)) {
    // Narrowing aid: upstreamRes is guaranteed truthy here only when
    // the second sub-condition matched (response existed but was
    // !ok / no body). Coerce defensively for the null short-circuit.
    const status = upstreamRes?.status ?? 0
    const text = await (upstreamRes?.text().catch(() => '') ?? Promise.resolve(''))
    const errMsg = `upstream ${status}: ${text.slice(0, 200)}`
    await fastify.prisma.inferenceRequest.update({
      where: { id: inferenceRequest.id },
      data: { status: 'FAILED', errorMessage: errMsg, completedAt: new Date() },
    })
    reply.code(502).send({
      error: { message: errMsg, type: 'server_error', code: 'upstream_failure' },
    })
    return
  }

  // Commit to SSE. From here on we write to reply.raw directly and
  // must not call reply.send().
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Disable nginx-style buffering at any intermediate proxy so the
    // buyer actually sees tokens as they arrive.
    'X-Accel-Buffering': 'no',
  })

  let accumulatedText = ''
  let upstreamUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null
  let upstreamId: string | null = null

  // Inline helper so both the fetch-reader and Anthropic-generator
  // paths share the same OpenAI-SSE event parser (id capture, content
  // accumulation, usage capture). The Anthropic adapter emits chunks
  // already in OpenAI SSE format, so the parser logic is identical.
  let sseBuffer = ''
  const consumeSseText = (text: string): void => {
    sseBuffer += text
    let sepIdx = sseBuffer.indexOf('\n\n')
    while (sepIdx !== -1) {
      const event = sseBuffer.slice(0, sepIdx)
      sseBuffer = sseBuffer.slice(sepIdx + 2)
      sepIdx = sseBuffer.indexOf('\n\n')
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice('data: '.length).trim()
        if (payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload) as {
            id?: string
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          if (parsed.id && !upstreamId) upstreamId = parsed.id
          const contentDelta = parsed.choices?.[0]?.delta?.content
          if (typeof contentDelta === 'string') accumulatedText += contentDelta
          if (parsed.usage) upstreamUsage = parsed.usage
        } catch {
          // Non-JSON SSE line — ignore. Buyer still got the bytes.
        }
      }
    }
  }

  try {
    if (anthropicStream) {
      // Anthropic adapter path: pull pre-translated SSE chunks from
      // the generator and write each one to the buyer's stream.
      for await (const chunk of anthropicStream.sseChunks) {
        raw.write(chunk)
        consumeSseText(chunk)
      }
      // The adapter's usage promise resolves once the stream closes
      // with the final token counts from message_start + message_delta.
      const adapterUsage = await anthropicStream.usage
      // Adapter usage takes precedence over anything the SSE chunks
      // showed (the adapter has the authoritative final values).
      upstreamUsage = {
        prompt_tokens: adapterUsage.inputTokens,
        completion_tokens: adapterUsage.outputTokens,
      }
    } else {
      // OpenAI / openai-compat / operator-worker path: stream the
      // upstream HTTP body to the buyer verbatim.
      // Type narrowing: the guard above proves upstreamRes + body are non-null here.
      const body = upstreamRes!.body!
      const decoder = new TextDecoder()
      const reader = body.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        // Pass through to the buyer verbatim — every byte the upstream
        // sent, the buyer gets, in order.
        raw.write(text)
        consumeSseText(text)
      }
    }
  } catch (err) {
    // Mid-stream upstream failure. Surface a final error event to
    // the buyer so their SDK doesn't hang.
    const msg = (err as Error).message
    raw.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg, type: 'server_error' } })}\n\n`)
    await fastify.prisma.inferenceRequest.update({
      where: { id: inferenceRequest.id },
      data: { status: 'FAILED', errorMessage: msg, completedAt: new Date() },
    }).catch(() => undefined)
    raw.end()
    return
  }

  raw.end()

  const latencyMs = Date.now() - startedAt

  // Token counts: upstream's usage block first; fall back to local
  // tokenizer over the accumulated assistant text + the prompt.
  let inputTokens = upstreamUsage?.prompt_tokens
  let outputTokens = upstreamUsage?.completion_tokens
  if (inputTokens == null || outputTokens == null) {
    const promptText = parsedRequest.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    const counted = countRequest(parsedRequest.model, promptText, accumulatedText)
    inputTokens ??= counted.inputTokens
    outputTokens ??= counted.outputTokens
  }

  // Meter — same as non-stream path. Don't surface errors to the
  // buyer (the stream already closed cleanly); just log and audit.
  try {
    await meterInferenceCall(fastify.prisma, {
      userId: auth.userId,
      apiKeyId: auth.keyId,
      model: parsedRequest.model,
      inputTokens,
      outputTokens,
      referenceId: inferenceRequest.id,
      operatorId: operatorNodeId,
      latencyMs,
    })
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      fastify.log.error({ err, requestId: inferenceRequest.id }, 'streaming inference unbillable')
    } else if (!(err instanceof UnknownModelError)) {
      fastify.log.error({ err, requestId: inferenceRequest.id }, 'streaming meter call failed')
    }
  }

  await fastify.prisma.inferenceRequest.update({
    where: { id: inferenceRequest.id },
    data: {
      status: 'COMPLETED',
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd: round8(
        (inputTokens * pricing.inputPricePerMillionTokens + outputTokens * pricing.outputPricePerMillionTokens) / 1_000_000,
      ),
      completedAt: new Date(),
    },
  })
}
