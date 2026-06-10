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

export function emitJobCompleted(
  fastify: FastifyInstance,
  data: A2EEvents['job:completed']
): void {
  fastify.io?.emit('job:completed', data)
}

export function emitJobFailed(
  fastify: FastifyInstance,
  data: A2EEvents['job:failed']
): void {
  fastify.io?.emit('job:failed', data)
}

export function emitNodeStatusChange(
  fastify: FastifyInstance,
  data: A2EEvents['node:statusChange']
): void {
  fastify.io?.emit('node:statusChange', data)
}

export function emitNotificationNew(
  fastify: FastifyInstance,
  data: A2EEvents['notification:new']
): void {
  // SECURITY (pen-test 2026-06-09/10 finding B-2): scoped to per-user
  // room. The payload's userId field is authoritative for routing;
  // global io.emit() leaked title+message (which encode payout/balance
  // amounts) to every connected client. See websocket/index.ts for the
  // per-user room auto-join on socket connect.
  fastify.io?.to(`user:${data.userId}`).emit('notification:new', data)
}
