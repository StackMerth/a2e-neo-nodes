/**
 * M2 / B2: template registry routes.
 *
 * Templates are pre-built environments (PyTorch+Jupyter, vLLM, ComfyUI,
 * etc.) the buyer can launch in one click. The catalog is curated by
 * admins; the agent uses popularity for idle-time image prewarm so the
 * buyer's launch-to-Jupyter latency stays sub-30s on warm nodes.
 *
 * Routes:
 *   GET   /v1/templates                        public, paginated catalog
 *   GET   /v1/templates/:slug                  public, single template by slug
 *   GET   /v1/templates/prewarm-list           agent-facing top-N for prewarm
 *   POST  /v1/admin/templates                  admin create
 *   PATCH /v1/admin/templates/:id              admin update (toggle isActive too)
 *   DELETE /v1/admin/templates/:id             admin delete (soft via isActive=false preferred)
 *
 * Public endpoints don't require auth — the catalog is intentionally
 * browsable so the marketplace can preview environments without a login.
 * Admin endpoints check authType='admin' on top of the global authenticate
 * preHandler.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const createSchema = z.object({
  slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric + dashes'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  dockerImage: z.string().min(1).max(255),
  defaultPort: z.number().int().min(1).max(65535).optional(),
  exposedPorts: z.array(z.number().int().min(1).max(65535)).optional(),
  envVars: z.record(z.string()).optional(),
  startupCommand: z.string().max(2000).optional(),
  iconUrl: z.string().url().max(500).optional(),
  category: z.string().max(64).optional(),
})

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
})

export async function templateRoutes(fastify: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Public catalog
  // -------------------------------------------------------------------------

  fastify.get('/v1/templates', async (request, reply) => {
    const query = request.query as { category?: string; limit?: string }
    const limit = Math.min(parseInt(query.limit ?? '50', 10), 100)

    const templates = await fastify.prisma.template.findMany({
      where: {
        isActive: true,
        ...(query.category ? { category: query.category } : {}),
      },
      orderBy: [{ popularity: 'desc' }, { name: 'asc' }],
      take: limit,
    })

    return reply.send({ templates })
  })

  fastify.get('/v1/templates/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }

    // Special-case the agent-facing prewarm-list slug so it doesn't
    // collide with normal template lookups.
    if (slug === 'prewarm-list') {
      const top = await fastify.prisma.template.findMany({
        where: { isActive: true },
        orderBy: { popularity: 'desc' },
        take: 3,
        select: { slug: true, dockerImage: true, popularity: true },
      })
      return reply.send({ templates: top })
    }

    const t = await fastify.prisma.template.findUnique({ where: { slug } })
    if (!t || !t.isActive) {
      return reply.code(404).send({ error: 'Template not found' })
    }
    return reply.send(t)
  })

  // -------------------------------------------------------------------------
  // Admin CRUD
  // -------------------------------------------------------------------------

  fastify.register(async function adminTemplateRoutes(adminFastify) {
    adminFastify.addHook('preHandler', adminFastify.authenticate)
    adminFastify.addHook('preHandler', async (request, reply) => {
      if (request.authType !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required' })
      }
    })

    adminFastify.post('/v1/admin/templates', async (request, reply) => {
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', details: parsed.error.errors })
      }
      const data = parsed.data
      const existing = await adminFastify.prisma.template.findUnique({ where: { slug: data.slug } })
      if (existing) {
        return reply.code(409).send({ error: 'Slug already exists' })
      }
      const created = await adminFastify.prisma.template.create({
        data: {
          ...data,
          envVars: data.envVars ?? undefined,
          exposedPorts: data.exposedPorts ?? [],
        },
      })
      return reply.code(201).send(created)
    })

    adminFastify.patch('/v1/admin/templates/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      const parsed = updateSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Validation Error', details: parsed.error.errors })
      }
      const updated = await adminFastify.prisma.template.update({
        where: { id },
        data: {
          ...parsed.data,
          envVars: parsed.data.envVars ?? undefined,
        },
      })
      return reply.send(updated)
    })

    adminFastify.delete('/v1/admin/templates/:id', async (request, reply) => {
      const { id } = request.params as { id: string }
      // Soft delete by default — preserves history for any ComputeRequest
      // that referenced this template.
      const updated = await adminFastify.prisma.template.update({
        where: { id },
        data: { isActive: false },
      })
      return reply.send({ id: updated.id, isActive: updated.isActive })
    })
  })
}
