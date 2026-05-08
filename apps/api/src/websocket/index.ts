// WebSocket Server Setup
// Real-time event broadcasting via Socket.io

import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { Server as SocketServer, Socket } from 'socket.io'
import { verifyAccessToken } from '../services/auth/jwt.js'

/**
 * Verify the legacy admin HMAC token issued by POST /v1/auth/login.
 * Same algorithm used by the auth plugin's Bearer-token path. Kept
 * inline here to avoid a circular import with the plugin module.
 * Will be replaced in M1 by a unified admin JWT.
 */
function verifyAdminHmacToken(token: string): boolean {
  try {
    const [data, signature] = token.split('.')
    if (!data || !signature) return false
    const JWT_SECRET = process.env.JWT_SECRET ?? 'a2e-jwt-secret-change-in-production'
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest('base64')
    if (signature !== expectedSignature) return false
    const payload = JSON.parse(Buffer.from(data, 'base64').toString()) as { exp?: number }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return false
    return true
  } catch {
    return false
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketServer
  }
}

export interface A2EEvents {
  'node:registered': {
    id: string
    walletAddress: string
    gpuTier: string
    status: string
    timestamp: string
  }
  'node:offline': {
    id: string
    walletAddress: string
    reason: string
    timestamp: string
  }
  'node:heartbeat': {
    nodeId: string
    gpuUtilization?: number
    gpuTemperature?: number
    gpuMemoryUsed?: number
    gpuMemoryTotal?: number
    timestamp: string
  }
  'job:routed': {
    jobId: string
    deploymentId: string
    gpuTier: string
    market: string
    ratePerHour: number
    ratePerDay: number
    reason: string
    yieldFloorApplied: boolean
    timestamp: string
  }
  'rate:updated': {
    market: string
    gpuTier: string
    ratePerHour: number
    ratePerDay: number
    timestamp: string
  }
  'job:completed': {
    jobId: string
    nodeId: string
    earnings: number | null
    durationSeconds: number | null
    timestamp: string
  }
  'job:failed': {
    jobId: string
    nodeId: string
    error: string | null
    timestamp: string
  }
  'node:statusChange': {
    nodeId: string
    oldStatus: string
    newStatus: string
    timestamp: string
  }
  'notification:new': {
    userId: string
    id: string
    type: string
    title: string
    message: string
  }
  'deployment:statusChange': {
    investmentId: string
    oldStatus: string
    newStatus: string
    nodeRunnerId: string
    timestamp: string
  }
}

export function setupWebSocket(fastify: FastifyInstance): SocketServer {
  const validApiKey = process.env.API_KEY ?? 'a2e-dev-key-2026'

  const io = new SocketServer(fastify.server, {
    cors: {
      origin: process.env.CORS_ORIGINS?.split(',') ?? [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'https://a2e-admin.stackforgelab.tech',
        'https://a2e-user.stackforgelab.tech',
        'https://compute.tokenos.ai',
      ],
      credentials: true,
    },
    path: '/socket.io',
  })

  // Authentication middleware — supports admin API key, portal JWT,
  // or admin HMAC Bearer token issued by /v1/auth/login.
  io.use((socket: Socket, next) => {
    // 1. Admin API key (legacy, kept for backwards compatibility)
    const apiKey = socket.handshake.auth?.apiKey ?? socket.handshake.headers['x-api-key']
    if (apiKey && apiKey === validApiKey) {
      return next()
    }

    // 2. Portal JWT (compute buyers, node runners) or admin HMAC token
    const token = socket.handshake.auth?.token
    if (token) {
      try {
        verifyAccessToken(token)
        return next()
      } catch {
        // Not a portal JWT, fall through to admin HMAC check
      }
      if (verifyAdminHmacToken(token)) {
        return next()
      }
      return next(new Error('Authentication failed: Invalid token'))
    }

    return next(new Error('Authentication failed: No credentials provided'))
  })

  io.on('connection', (socket: Socket) => {
    fastify.log.info({ socketId: socket.id }, 'WebSocket client connected')

    // Allow clients to subscribe to specific event types
    socket.on('subscribe', (events: string | string[]) => {
      const eventList = Array.isArray(events) ? events : [events]
      for (const event of eventList) {
        socket.join(event)
        fastify.log.debug({ socketId: socket.id, event }, 'Client subscribed to event')
      }
    })

    socket.on('unsubscribe', (events: string | string[]) => {
      const eventList = Array.isArray(events) ? events : [events]
      for (const event of eventList) {
        socket.leave(event)
        fastify.log.debug({ socketId: socket.id, event }, 'Client unsubscribed from event')
      }
    })

    socket.on('disconnect', (reason: string) => {
      fastify.log.info({ socketId: socket.id, reason }, 'WebSocket client disconnected')
    })

    socket.on('error', (error: Error) => {
      fastify.log.error({ socketId: socket.id, error: error.message }, 'WebSocket error')
    })

    // Send welcome message
    socket.emit('connected', {
      message: 'Connected to A²E WebSocket server',
      timestamp: new Date().toISOString(),
    })
  })

  // Decorate fastify with io instance
  fastify.decorate('io', io)

  // Clean up on server close
  fastify.addHook('onClose', async () => {
    io.close()
  })

  return io
}
