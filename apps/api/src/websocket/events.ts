// WebSocket Event Emitter Helpers
// Type-safe event emission

import type { FastifyInstance } from 'fastify'
import type { A2EEvents } from './index'

export function emitNodeRegistered(
  fastify: FastifyInstance,
  data: A2EEvents['node:registered']
): void {
  fastify.io?.emit('node:registered', data)
}

export function emitNodeOffline(
  fastify: FastifyInstance,
  data: A2EEvents['node:offline']
): void {
  fastify.io?.emit('node:offline', data)
}

export function emitNodeHeartbeat(
  fastify: FastifyInstance,
  data: A2EEvents['node:heartbeat']
): void {
  fastify.io?.emit('node:heartbeat', data)
}

export function emitJobRouted(
  fastify: FastifyInstance,
  data: A2EEvents['job:routed']
): void {
  fastify.io?.emit('job:routed', data)
}

export function emitRateUpdated(
  fastify: FastifyInstance,
  data: A2EEvents['rate:updated']
): void {
  fastify.io?.emit('rate:updated', data)
}
