import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { generateApiKey, revokeApiKey, listApiKeys } from '../services/apikey/manager.js'

const createSchema = z.object({
  name: z.string().min(1).max(100),
  permissions: z.array(z.string()).default(['compute:read', 'compute:write']),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

export async function buyerApiKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * POST /v1/buyer/api-keys — Create a new API key
   */
  fastify.post('/v1/buyer/api-keys', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { name, permissions, expiresInDays } = parsed.data
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : undefined

    const result = await generateApiKey(request.user!.userId, name, permissions, expiresAt)

    reply.code(201).send({
      id: result.id,
      key: result.key, // Full key shown ONCE
      name: result.name,
      permissions: result.permissions,
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
      message: 'Save this key now — it will not be shown again.',
    })
  })

  /**
   * GET /v1/buyer/api-keys — List API keys (masked)
   */
  fastify.get('/v1/buyer/api-keys', async (request, reply) => {
    const keys = await listApiKeys(request.user!.userId)
    reply.send({ keys })
  })

  /**
   * DELETE /v1/buyer/api-keys/:id — Revoke an API key
   */
  fastify.delete('/v1/buyer/api-keys/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await revokeApiKey(id, request.user!.userId)

    if (!result) {
      return reply.code(404).send({ error: 'API key not found' })
    }

    reply.send({ success: true, message: 'API key revoked' })
  })
}
