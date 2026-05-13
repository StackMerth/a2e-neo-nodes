// WebSocket Server Setup
// Real-time event broadcasting via Socket.io

import type { FastifyInstance } from 'fastify'
import { Server as SocketServer, Socket } from 'socket.io'
import { verifyAccessToken } from '../services/auth/jwt.js'

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
        'http://localhost:3003',
        // Production (tokenos.ai)
        'https://admin.tokenos.ai',
        'https://user.tokenos.ai',
        'https://market.tokenos.ai',
        // Legacy (kept briefly so bookmarks keep working)
        'https://a2e-admin.stackforgelab.tech',
        'https://a2e-user.stackforgelab.tech',
        'https://marketplace.stackforgelab.tech',
      ],
      credentials: true,
    },
    path: '/socket.io',
  })

  // Authentication middleware. Two valid auth shapes:
  //   - X-API-Key header / handshake.auth.apiKey: legacy admin global key
  //   - handshake.auth.token: JWT (portal users or admin per role)
  io.use((socket: Socket, next) => {
    const apiKey = socket.handshake.auth?.apiKey ?? socket.handshake.headers['x-api-key']
    if (apiKey && apiKey === validApiKey) {
      return next()
    }

    const token = socket.handshake.auth?.token
    if (token) {
      try {
        verifyAccessToken(token)
        return next()
      } catch {
        return next(new Error('Authentication failed: Invalid token'))
      }
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
