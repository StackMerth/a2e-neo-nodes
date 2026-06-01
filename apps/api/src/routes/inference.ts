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

    if (parsed.data.stream === true) {
      return reply.code(400).send({
        error: {
          message: 'stream=true is not yet supported on this endpoint (lands in E2.3). Set stream=false or omit.',
          type: 'invalid_request_error',
          code: 'streaming_not_yet_supported',
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

  // Translate the model id to the provider's id without disturbing
  // the rest of the request body. Pass everything else through.
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
