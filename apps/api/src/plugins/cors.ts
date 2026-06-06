// CORS Plugin Configuration
// Configures Cross-Origin Resource Sharing

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'

const corsPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',') ?? [
    // Local dev ports
    'http://localhost:3000', // dashboard
    'http://localhost:3001', // api (rare; included for local cross-port testing)
    'http://localhost:3002', // portal
    'http://localhost:3003', // marketplace
    // Production subdomains (tokenos.ai)
    'https://admin.tokenos.ai',
    'https://user.tokenos.ai',
    'https://market.tokenos.ai',
    // Legacy subdomains (kept temporarily so anyone with bookmarks
    // still reaches the API while DNS settles).
    'https://a2e-admin.stackforgelab.tech',
    'https://a2e-user.stackforgelab.tech',
    'https://marketplace.stackforgelab.tech',
  ]

  await fastify.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Note: 'solana-client' is added because @solana/web3.js Connection
    // sets that header on every JSON-RPC POST (its way of self-identifying
    // version/runtime to RPC endpoints). Without it in this allowlist
    // the preflight returns 204 but the browser refuses to send the
    // actual POST since its required headers aren't sanctioned by the
    // preflight response — manifesting as "CORS error" in DevTools and
    // "TypeError: Failed to fetch" inside the wallet adapter. Hitting
    // Helius directly worked because Helius returns Access-Control-Allow-
    // Headers: *; our own proxy needs the explicit allowance.
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'solana-client'],
    credentials: true,
  })
}

export default fp(corsPlugin, {
  name: 'cors',
  dependencies: [],
})
