/**
 * Web Push (VAPID) endpoints for the portal.
 *
 * Flow:
 *   1. Frontend fetches GET /v1/portal/push/public-key to get the
 *      VAPID public key the service worker needs to subscribe.
 *   2. Service worker calls PushManager.subscribe with that key.
 *   3. Frontend POSTs the resulting { endpoint, keys.p256dh,
 *      keys.auth } to /v1/portal/push/subscribe.
 *   4. To unsubscribe, frontend posts the endpoint to
 *      /v1/portal/push/unsubscribe.
 *
 * GET /public-key is unauthenticated so the service worker can fetch
 * it without a token. Subscribe + unsubscribe require auth — only a
 * signed-in user can attach a push target to their account.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getPushPublicKey, isPushConfigured } from '../services/notification/push.js'

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
})

export async function portalPushRoutes(fastify: FastifyInstance) {
  // GET /v1/portal/push/public-key — unauth; service worker reads this.
  fastify.get('/v1/portal/push/public-key', async (_request, reply) => {
    const key = getPushPublicKey()
    if (!key) {
      return reply.code(503).send({
        configured: false,
        error: 'push_not_configured',
        message: 'Web Push is not configured on this deploy. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT.',
      })
    }
    reply.send({ configured: true, publicKey: key })
  })

  // Subscribe + unsubscribe both require auth.
  fastify.post('/v1/portal/push/subscribe', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })
    if (!isPushConfigured()) return reply.code(503).send({ error: 'push_not_configured' })

    const parsed = subscribeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      })
    }

    const { endpoint, keys } = parsed.data
    const userAgent = (request.headers['user-agent'] as string | undefined) ?? null

    // upsert by endpoint: re-subscribing the same browser updates
    // the row instead of leaving a stale duplicate.
    const row = await fastify.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: request.user.userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent,
      },
      update: {
        userId: request.user.userId,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent,
      },
      select: { id: true },
    })

    reply.send({ success: true, id: row.id })
  })

  fastify.post('/v1/portal/push/unsubscribe', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })

    const parsed = unsubscribeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }

    // deleteMany so a stale endpoint registered against a different
    // user (impossible today, defensive for future migration) does
    // not crash the unsubscribe flow.
    await fastify.prisma.pushSubscription.deleteMany({
      where: { endpoint: parsed.data.endpoint, userId: request.user.userId },
    })

    reply.send({ success: true })
  })

  // GET /v1/portal/push/status — does this user have any active subs?
  fastify.get('/v1/portal/push/status', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })
    if (!isPushConfigured()) {
      return reply.send({ configured: false, subscribed: false, count: 0 })
    }
    const count = await fastify.prisma.pushSubscription.count({
      where: { userId: request.user.userId },
    })
    reply.send({ configured: true, subscribed: count > 0, count })
  })
}
