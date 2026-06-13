// External Market Admin Routes (M7 F5.1)
//
// Admin-only REST surface for inspecting and driving the external-market
// overflow system. Every route sits under `/v1/external` and runs through
// `fastify.authenticate`. The route handlers are thin wrappers around the
// pure functions in `./external-handlers.ts` — see that file for the real
// logic. Keeping the wrapper small lets unit tests cover the business rules
// without booting a Fastify instance.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  EXTERNAL_MARKETS,
  adminDelistNode,
  adminListNode,
  getDeploymentDetail,
  getExternalEarnings,
  getExternalStatus,
  getOverflowConfigResponse,
  listDeployments,
  updateOverflowConfig,
  type ExternalMarket,
  type HandlerResult,
} from './external-handlers'

const marketSchema = z.enum(EXTERNAL_MARKETS as unknown as [ExternalMarket, ...ExternalMarket[]])

const listBodySchema = z
  .object({
    market: marketSchema.optional(),
  })
  .strict()

const delistQuerySchema = z
  .object({
    mode: z.enum(['safe', 'force']).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .passthrough()

const earningsQuerySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    nodeId: z.string().optional(),
    market: marketSchema.optional(),
  })
  .passthrough()

const patchConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    simulationMode: z.boolean().optional(),
    idleThresholdMinutes: z.number().int().min(1).max(1440).optional(),
    demandThresholdPercent: z.number().int().min(0).max(100).optional(),
    marginProtectionPercent: z.number().int().min(0).max(100).optional(),
    gracePeriodSeconds: z.number().int().min(0).max(3600).optional(),
    preferredMarkets: z.array(marketSchema).optional(),
  })
  .strict()

function applyResult<T>(reply: FastifyReply, result: HandlerResult<T>): void {
  reply.code(result.status).send(result.body)
}

function zodErrorBody(err: z.ZodError): { error: string; message: string; issues: unknown } {
  return {
    error: 'Bad Request',
    message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
    issues: err.errors,
  }
}

export async function externalRoutes(fastify: FastifyInstance): Promise<void> {
  // SECURITY (N-1, 2026-06-13): all /v1/external/* routes are
  // admin-only. The plugin's file header has always said so but the
  // role check was missing, leaving the overflow control plane
  // (status / deployments / earnings reads PLUS POST /list, PATCH
  // /config, DELETE /list mutators) reachable by any authenticated
  // buyer. A buyer could read the overflow config (margin protection,
  // preferred markets) and could mutate listing state if they fired
  // the POST/PATCH/DELETE endpoints. Mirrors admin-compute's gate.
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('ADMIN'))

  fastify.get('/v1/external/status', async (_request, reply) => {
    const result = await getExternalStatus(fastify.prisma, fastify.overflowRegistry)
    applyResult(reply, result)
  })

  fastify.get('/v1/external/deployments', async (request, reply) => {
    const { status } = (request.query as { status?: string }) ?? {}
    const result = await listDeployments(fastify.prisma, { status })
    applyResult(reply, result)
  })

  fastify.get('/v1/external/deployments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await getDeploymentDetail(fastify.prisma, id)
    applyResult(reply, result)
  })

  fastify.post('/v1/external/list/:nodeId', async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string }
    const parsed = listBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400).send(zodErrorBody(parsed.error))
      return
    }
    const result = await adminListNode(fastify.prisma, fastify.overflowRegistry, {
      nodeId,
      market: parsed.data.market,
    })
    applyResult(reply, result)
  })

  fastify.delete('/v1/external/list/:nodeId', async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string }
    const parsed = delistQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      reply.code(400).send(zodErrorBody(parsed.error))
      return
    }
    const result = await adminDelistNode(fastify.prisma, fastify.overflowRegistry, {
      nodeId,
      mode: parsed.data.mode ?? 'safe',
      reason: parsed.data.reason,
    })
    applyResult(reply, result)
  })

  fastify.get('/v1/external/earnings', async (request, reply) => {
    const parsed = earningsQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      reply.code(400).send(zodErrorBody(parsed.error))
      return
    }
    const result = await getExternalEarnings(fastify.prisma, parsed.data)
    applyResult(reply, result)
  })

  fastify.get('/v1/external/config', async (_request, reply) => {
    const result = await getOverflowConfigResponse(fastify.prisma)
    applyResult(reply, result)
  })

  fastify.patch('/v1/external/config', async (request, reply) => {
    const parsed = patchConfigSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400).send(zodErrorBody(parsed.error))
      return
    }
    const result = await updateOverflowConfig(fastify.prisma, parsed.data)
    applyResult(reply, result)
  })
}
