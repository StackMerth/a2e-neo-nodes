/**
 * M5.5: OpenAPI / Swagger UI plugin.
 *
 * Generates the OpenAPI 3 spec from Fastify route schemas, serves the
 * raw spec at /docs/json and an interactive Swagger UI at /docs.
 * Tagged routes (e.g. tags: ['Public']) appear grouped in the UI.
 *
 * Must be registered BEFORE any routes that should appear in the spec.
 */

import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

const API_URL = process.env.API_URL ?? 'https://a2e-api.onrender.com'

export default fp(async (fastify) => {
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
