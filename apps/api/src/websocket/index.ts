// WebSocket Server Setup
// Real-time event broadcasting via Socket.io

import type { FastifyInstance } from 'fastify'
import { Server as SocketServer, Socket } from 'socket.io'

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
}

export function setupWebSocket(fastify: FastifyInstance): SocketServer {
  const validApiKey = process.env.API_KEY ?? 'a2e-dev-key-2026'

  const io = new SocketServer(fastify.server, {
    cors: {
      origin: process.env.CORS_ORIGINS?.split(',') ?? [
        'http://localhost:3000',
        'http://localhost:3001',
        'https://a2e.byredstone.com',
        'https://compute.tokenos.ai',
      ],
      credentials: true,
    },
    path: '/socket.io',
  })

  // Authentication middleware
  io.use((socket: Socket, next) => {
    const apiKey = socket.handshake.auth?.apiKey ?? socket.handshake.headers['x-api-key']

    if (!apiKey || apiKey !== validApiKey) {
      return next(new Error('Authentication failed: Invalid API key'))
    }

    next()
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
