/**
 * M5.5: OpenAPI / Swagger UI plugin.
 *
 * Generates the OpenAPI 3 spec from Fastify route schemas, serves the
 * raw spec at /docs/json and an interactive Swagger UI at /docs.
 * Tagged routes (e.g. tags: ['Public']) appear grouped in the UI.
 *
 * SECURITY GATE (2026-06-09 pen-test finding A2E_AUTOPAYOUT_DRAIN):
 * /docs/json publicly disclosed the full route table (~250 endpoints)
 * to an unauthenticated caller, which gave the attacker a free
 * reconnaissance map of every undefended path. We now gate the docs
 * behind two layers:
 *
 *   1. EXPOSE_DOCS env flag (default false in prod). If unset/false,
 *      the swagger plugin does NOT register at all — /docs and
 *      /docs/json simply do not exist. This is the recommended prod
 *      posture; flip to true only when you need the spec briefly.
 *
 *   2. When EXPOSE_DOCS=true, an onRequest hook rejects any request
 *      to /docs* that isn't authenticated as ADMIN. Returns 404 (not
 *      403) so the response shape matches "endpoint does not exist"
 *      and the path's existence is not confirmed.
 *
 * Local dev: set EXPOSE_DOCS=true in apps/api/.env to keep the
 * familiar workflow; admin-only check still applies but you can hit
 * the docs with the admin API key.
 *
 * Must be registered BEFORE any routes that should appear in the spec.
 */

import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { verifyAccessToken } from '../services/auth/jwt.js'

const API_URL = process.env.API_URL ?? 'https://a2e-api.onrender.com'

function isDocsEnabled(): boolean {
  const raw = process.env.EXPOSE_DOCS?.toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

export default fp(async (fastify) => {
  if (!isDocsEnabled()) {
    fastify.log.info(
      '[swagger] EXPOSE_DOCS is not true — /docs and /docs/json are NOT registered. ' +
        'Set EXPOSE_DOCS=true (and authenticate as ADMIN) to enable.',
    )
    return
  }

  fastify.log.warn(
    '[swagger] EXPOSE_DOCS=true — /docs registered but ADMIN-only. ' +
      'Disable in prod by removing EXPOSE_DOCS unless actively needed.',
  )

  // Admin-only gate on every /docs* request. Runs BEFORE the swagger
  // plugin's route handlers so unauthenticated callers see a 404 and
  // cannot tell whether the path exists.
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/docs')) return

    // Reuse the existing admin-api-key check from the auth plugin.
    // request.authType is populated by the global `authenticate`
    // decorator, but onRequest fires BEFORE that — so we re-derive
    // the admin check inline. Two acceptable signals:
    //   - X-API-Key header matches process.env.ADMIN_API_KEY
    //   - Bearer JWT whose decoded user has role=ADMIN OR isAdmin=true
    const adminKeyHeader = request.headers['x-api-key']
    const expectedAdminKey = process.env.ADMIN_API_KEY
    if (
      expectedAdminKey &&
      typeof adminKeyHeader === 'string' &&
      adminKeyHeader === expectedAdminKey
    ) {
      return
    }

    const authHeader = request.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      try {
        const decoded = verifyAccessToken(token)
        if (decoded.role === 'ADMIN') return
        // Slow path: check DB flag in case the JWT was minted before
        // an admin upgrade landed in the row.
        const user = await fastify.prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { isAdmin: true },
        })
        if (user?.isAdmin) return
      } catch {
        // fall through to 404
      }
    }

    reply.code(404).send({ error: 'Not Found' })
  })

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'A2E Marketplace API',
        description: [
          'Public and authenticated endpoints for the A2E GPU compute marketplace.',
          '',
          'Public routes (no auth) describe live inventory, operator profiles, and the reputation leaderboard.',
          'Buyer routes (Bearer JWT) handle compute request creation, billing, and rental lifecycle.',
        ].join('\n'),
        version: '1.0.0',
      },
      servers: [
        { url: API_URL, description: 'Production' },
      ],
      tags: [
        { name: 'Public', description: 'No-auth catalog, leaderboard, and operator profiles' },
        { name: 'Buyer', description: 'Compute request lifecycle (Bearer JWT required)' },
        { name: 'Health', description: 'Liveness and per-component health probes' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
      tryItOutEnabled: true,
    },
    staticCSP: true,
  })
})
