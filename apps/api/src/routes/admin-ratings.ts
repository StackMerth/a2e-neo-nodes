/**
 * M3 / C1 admin ratings moderation routes.
 *
 * Buyers submit ratings via POST /v1/buyer/compute/requests/:id/rate
 * (default moderationStatus = PENDING). Admins approve/reject from
 * the Ratings page on the dashboard. Only APPROVED ratings count
 * toward an operator's reputationScore (M3.2 scorer reads only
 * APPROVED rows) and appear on their public profile (M3.8).
 *
 * Why moderation
 *   First-launch protection against:
 *     - Review-bombing campaigns
 *     - Vindictive 1-star ratings from buyers whose rental had a
 *       legitimate fault that wasn't the operator's
 *     - Confidential information accidentally pasted into the comment
 *   Once the platform has enough volume + trust signals, we can switch
 *   to auto-publish-with-flag (an M5 polish item).
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createNotification } from '../services/notification/service.js'

const rejectSchema = z.object({
  note: z.string().max(500).optional(),
})

export async function adminRatingsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.authType !== 'admin') {
      return reply.code(403).send({ error: 'Admin access required' })
    }
  })

  /**
   * GET /v1/admin/ratings — list ratings, optionally filtered by status.
   * Default: PENDING (the moderation queue).
   */
  fastify.get('/v1/admin/ratings', async (request, reply) => {
    const status = (request.query as { status?: string }).status ?? 'PENDING'

    const where: Record<string, unknown> = {}
    if (status !== 'all') {
      where.moderationStatus = status
    }

    const ratings = await fastify.prisma.rating.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        buyer: { select: { id: true, email: true, walletAddress: true } },
        nodeRunner: { select: { id: true, name: true, slug: true } },
        computeRequest: {
          select: {
            id: true,
            gpuTier: true,
            gpuCount: true,
            durationDays: true,
            totalCost: true,
            tier: true,
            completedAt: true,
          },
        },
      },
    })

    const counts = {
      pending: await fastify.prisma.rating.count({ where: { moderationStatus: 'PENDING' } }),
      approved: await fastify.prisma.rating.count({ where: { moderationStatus: 'APPROVED' } }),
      rejected: await fastify.prisma.rating.count({ where: { moderationStatus: 'REJECTED' } }),
    }

    return reply.send({ ratings, counts })
  })

  /**
   * PATCH /v1/admin/ratings/:id/approve — moderation action: approve.
   * Notifies the operator that they have a new public rating.
   */
  fastify.patch('/v1/admin/ratings/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string }

    const rating = await fastify.prisma.rating.findUnique({
      where: { id },
      include: { nodeRunner: { select: { userId: true } } },
    })
    if (!rating) return reply.code(404).send({ error: 'Rating not found' })
    if (rating.moderationStatus !== 'PENDING') {
      return reply.code(400).send({
        error: `Cannot approve: status is ${rating.moderationStatus}`,
      })
    }

    await fastify.prisma.rating.update({
      where: { id },
      data: {
        moderationStatus: 'APPROVED',
        moderatedAt: new Date(),
      },
    })

    if (rating.nodeRunner.userId) {
      void createNotification(
        rating.nodeRunner.userId,
        'PAYOUT_SENT', // closest existing type for "good news from the platform"
        'New Rating Approved',
        `You received a ${rating.score}-star rating. View it on your operator profile.`,
        '/dashboard',
      )
    }

    return reply.send({ id, moderationStatus: 'APPROVED' })
  })

  /**
   * PATCH /v1/admin/ratings/:id/reject — moderation action: reject.
   * Optional note explains why. Operator is NOT notified (rejected
   * ratings are private to the moderation team).
   */
  fastify.patch('/v1/admin/ratings/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = rejectSchema.safeParse(request.body)

    const rating = await fastify.prisma.rating.findUnique({
      where: { id },
      select: { moderationStatus: true },
    })
    if (!rating) return reply.code(404).send({ error: 'Rating not found' })
    if (rating.moderationStatus !== 'PENDING') {
      return reply.code(400).send({
        error: `Cannot reject: status is ${rating.moderationStatus}`,
      })
    }

    await fastify.prisma.rating.update({
      where: { id },
      data: {
        moderationStatus: 'REJECTED',
        moderationNote: parsed.success ? parsed.data.note ?? null : null,
        moderatedAt: new Date(),
      },
    })

    return reply.send({ id, moderationStatus: 'REJECTED' })
  })
}
