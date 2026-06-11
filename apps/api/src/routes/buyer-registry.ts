/**
 * E6 / M3.11: Buyer-facing Docker registry API.
 *
 * Endpoints (all mounted under /v1/buyer/registry/*, all behind the
 * standard portal JWT auth + COMPUTE_BUYER role check):
 *
 *   GET    /v1/buyer/registry/images           paginated list
 *   GET    /v1/buyer/registry/images/:id       detail + latest scan
 *   DELETE /v1/buyer/registry/images/:id       soft-delete (sets deletedAt)
 *   GET    /v1/buyer/registry/quota            current usage + limit
 *
 * Pagination uses opaque cursors (the last image's id) rather than
 * offset-based, so a buyer pushing/deleting images mid-page doesn't
 * see duplicates or skips. Mirrors the pattern in buyer-balance.ts.
 *
 * Soft-delete vs hard-delete: we never blow away DockerImage rows
 * because they're referenced from ImageScan history. The deletedAt
 * marker hides the image from listings + flips pullBlocked so the
 * token issuer denies pulls. Registry blobs in R2 stay until the
 * registry's garbage collection sweep removes orphans (~weekly).
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  getQuotaSnapshot,
  quotaSnapshotToJson,
} from '../services/registry/quota.js'

/**
 * Convert a DockerImage row (with optional latest scan) into the
 * buyer-facing JSON shape. BigInt -> Number happens here, once.
 */
function imageToJson(image: {
  id: string
  userId: string
  repository: string
  tag: string
  digest: string
  sizeBytes: bigint
  pushedAt: Date
  deletedAt: Date | null
  pullBlocked: boolean
  pullBlockReason: string | null
  scans?: Array<{
    id: string
    status: string
    criticalCount: number
    highCount: number
    mediumCount: number
    lowCount: number
    unknownCount: number
    startedAt: Date
    completedAt: Date | null
  }>
}) {
  const latestScan = image.scans?.[0]
  return {
    id: image.id,
    repository: image.repository,
    tag: image.tag,
    digest: image.digest,
    sizeBytes: Number(image.sizeBytes),
    pushedAt: image.pushedAt.toISOString(),
    deletedAt: image.deletedAt?.toISOString() ?? null,
    pullBlocked: image.pullBlocked,
    pullBlockReason: image.pullBlockReason,
    latestScan: latestScan
      ? {
          id: latestScan.id,
          status: latestScan.status,
          criticalCount: latestScan.criticalCount,
          highCount: latestScan.highCount,
          mediumCount: latestScan.mediumCount,
          lowCount: latestScan.lowCount,
          unknownCount: latestScan.unknownCount,
          startedAt: latestScan.startedAt.toISOString(),
          completedAt: latestScan.completedAt?.toISOString() ?? null,
        }
      : null,
  }
}

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // includeDeleted defaults to false so a buyer's "my images" view
  // only shows live ones. Admin tooling that wants the full history
  // can opt in.
  includeDeleted: z.coerce.boolean().optional(),
})

export async function buyerRegistryRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * GET /v1/buyer/registry/quota — current usage snapshot
   */
  fastify.get('/v1/buyer/registry/quota', async (request, reply) => {
    const userId = request.user!.userId
    const snapshot = await getQuotaSnapshot(fastify.prisma, userId)
    reply.send(quotaSnapshotToJson(snapshot))
  })

  /**
   * GET /v1/buyer/registry/images — paginated list
   * Sort: pushedAt DESC (newest first).
   */
  fastify.get('/v1/buyer/registry/images', async (request, reply) => {
    const userId = request.user!.userId
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid query params' })
    }
    const { cursor, limit = 20, includeDeleted = false } = parsed.data

    const images = await fastify.prisma.dockerImage.findMany({
      where: {
        userId,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: { pushedAt: 'desc' },
      take: limit + 1, // fetch one extra to detect "has more"
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        scans: {
          orderBy: { startedAt: 'desc' },
          take: 1,
        },
      },
    })

    const hasMore = images.length > limit
    const page = hasMore ? images.slice(0, limit) : images
    const nextCursor = hasMore && page.length > 0
      ? page[page.length - 1]!.id
      : null

    reply.send({
      images: page.map(imageToJson),
      nextCursor,
    })
  })

  /**
   * GET /v1/buyer/registry/images/:id — single image + latest scan
   * 404 if the image doesn't exist OR belongs to a different user
   * (we don't expose existence of other users' images).
   */
  fastify.get<{ Params: { id: string } }>(
    '/v1/buyer/registry/images/:id',
    async (request, reply) => {
      const userId = request.user!.userId
      const image = await fastify.prisma.dockerImage.findFirst({
        where: { id: request.params.id, userId },
        include: {
          scans: {
            orderBy: { startedAt: 'desc' },
            take: 1,
          },
        },
      })
      if (!image) return reply.code(404).send({ error: 'image not found' })
      reply.send(imageToJson(image))
    },
  )

  /**
   * DELETE /v1/buyer/registry/images/:id — soft-delete
   * Sets deletedAt + pullBlocked so the registry's auth check denies
   * subsequent pulls. The R2 blob stays until registry GC runs.
   * Re-pushing the same (repo, tag) brings the row back (upsert in
   * the webhook clears deletedAt + pullBlocked).
   */
  fastify.delete<{ Params: { id: string } }>(
    '/v1/buyer/registry/images/:id',
    async (request, reply) => {
      const userId = request.user!.userId
      // Use updateMany + count so we can distinguish "not found" from
      // "already deleted" without an extra find query.
      const result = await fastify.prisma.dockerImage.updateMany({
        where: { id: request.params.id, userId, deletedAt: null },
        data: {
          deletedAt: new Date(),
          pullBlocked: true,
          pullBlockReason: 'Deleted by buyer',
        },
      })
      if (result.count === 0) {
        return reply.code(404).send({ error: 'image not found or already deleted' })
      }
      reply.send({ deleted: true })
    },
  )
}
