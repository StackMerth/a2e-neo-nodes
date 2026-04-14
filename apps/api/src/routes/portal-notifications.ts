import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  unreadOnly: z.coerce.boolean().default(false),
})

export async function portalNotificationRoutes(fastify: FastifyInstance) {
  // All routes require authentication
  fastify.addHook('preHandler', fastify.authenticate)

  /**
   * GET /v1/portal/notifications
   */
  fastify.get('/v1/portal/notifications', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })

    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error' })
    }
    const { page, limit, unreadOnly } = parsed.data

    const where: Record<string, unknown> = { userId: request.user.userId }
    if (unreadOnly) where.read = false

    const [notifications, total] = await Promise.all([
      fastify.prisma.notification.findMany({
        where,
        orderBy: [{ read: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      fastify.prisma.notification.count({ where }),
    ])

    reply.send({ notifications, total, page, limit, pages: Math.ceil(total / limit) })
  })

  /**
   * GET /v1/portal/notifications/unread-count
   */
  fastify.get('/v1/portal/notifications/unread-count', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })

    const count = await fastify.prisma.notification.count({
      where: { userId: request.user.userId, read: false },
    })

    reply.send({ count })
  })

  /**
   * PATCH /v1/portal/notifications/:id/read
   */
  fastify.patch('/v1/portal/notifications/:id/read', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })
    const { id } = request.params as { id: string }

    const notification = await fastify.prisma.notification.findFirst({
      where: { id, userId: request.user.userId },
    })
    if (!notification) return reply.code(404).send({ error: 'Notification not found' })

    await fastify.prisma.notification.update({
      where: { id },
      data: { read: true },
    })

    reply.send({ success: true })
  })

  /**
   * PATCH /v1/portal/notifications/read-all
   */
  fastify.patch('/v1/portal/notifications/read-all', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })

    const result = await fastify.prisma.notification.updateMany({
      where: { userId: request.user.userId, read: false },
      data: { read: true },
    })

    reply.send({ success: true, count: result.count })
  })

  /**
   * DELETE /v1/portal/notifications/:id
   */
  fastify.delete('/v1/portal/notifications/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })
    const { id } = request.params as { id: string }

    const notification = await fastify.prisma.notification.findFirst({
      where: { id, userId: request.user.userId },
    })
    if (!notification) return reply.code(404).send({ error: 'Notification not found' })

    await fastify.prisma.notification.delete({ where: { id } })

    reply.send({ success: true })
  })
}
