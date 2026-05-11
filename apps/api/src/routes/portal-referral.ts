/**
 * M5.7 / D2: portal referral routes.
 *
 * GET /v1/portal/referral
 *   Returns the authenticated operator's referral code, list of
 *   referees, and lifetime commission accrued. Auto-generates a code on
 *   first call if the operator does not have one yet.
 */

import type { FastifyInstance } from 'fastify'
import { ensureReferralCode } from '../services/referral/code.js'

export async function portalReferralRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('NODE_RUNNER', 'ADMIN'))

  fastify.get('/v1/portal/referral', {
    schema: {
      tags: ['Portal'],
      summary: 'Get the authenticated operator referral code, referees, and lifetime commission',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const userId = (request as { user?: { userId: string } }).user?.userId
    if (!userId) return reply.code(401).send({ error: 'Not authenticated' })

    const runner = await fastify.prisma.nodeRunner.findUnique({
      where: { userId },
      select: { id: true, name: true, referralCode: true },
    })
    if (!runner) return reply.code(404).send({ error: 'No node-runner profile for this user' })

    const code = await ensureReferralCode(fastify.prisma, runner.id)

    const referrals = await fastify.prisma.referral.findMany({
      where: { referrerNodeRunnerId: runner.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        totalCommissionAccrued: true,
        createdAt: true,
        expiresAt: true,
        lastSettledAt: true,
        referee: {
          select: {
            name: true,
            slug: true,
            createdAt: true,
          },
        },
      },
    })

    const lifetimeCommission = referrals.reduce(
      (sum, r) => sum + r.totalCommissionAccrued,
      0,
    )

    return reply.send({
      referralCode: code,
      shareUrl: `https://marketplace.stackforgelab.tech/?ref=${code}`,
      lifetimeCommission: Number(lifetimeCommission.toFixed(4)),
      refereeCount: referrals.length,
      activeReferees: referrals.filter(r => r.status === 'ACTIVE').length,
      referrals: referrals.map(r => ({
        id: r.id,
        status: r.status,
        commissionAccrued: Number(r.totalCommissionAccrued.toFixed(4)),
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        lastSettledAt: r.lastSettledAt?.toISOString() ?? null,
        referee: {
          name: r.referee.name,
          slug: r.referee.slug,
          joinedAt: r.referee.createdAt.toISOString(),
        },
      })),
    })
  })
}
