import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  generateApiKey,
  revokeApiKey,
  listApiKeys,
  DEFAULT_BUYER_KEY_PERMISSIONS,
} from '../services/apikey/manager.js'

const createSchema = z.object({
  name: z.string().min(1).max(100),
  // E2.2: defaults now include 'inference:write' so a fresh key works
  // against /v1/chat/completions out of the box. Buyers can pass their
  // own permissions array to narrow scope.
  permissions: z.array(z.string()).default(DEFAULT_BUYER_KEY_PERMISSIONS),
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

    // SECURITY (2026-06-11 third-round follow-up): refuse API key
    // minting for unverified buyers. An API key is the credential used
    // to call paid endpoints (inference, chat completions). Pairs with
    // L2 HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS in eligibility.ts so the
    // verification gate is consistent across every money-touching
    // action a brand-new buyer can take.
    const me = await fastify.prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { emailVerified: true },
    })
    if (!me?.emailVerified) {
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Verify your email before creating API keys. Check your inbox for the verification link, or use the resend button in the dashboard.',
      })
    }

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
