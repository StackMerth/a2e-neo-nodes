/**
 * Track 5 / E2.1 — inference worker registration + heartbeat endpoints.
 *
 * An operator runs a vLLM / SGLang / TGI container ("inference worker")
 * on one of their nodes. The container is what actually serves OpenAI-
 * compatible inference requests for buyers. This file exposes three
 * surfaces:
 *
 *   1. POST /v1/inference-workers/register
 *      Called once at worker startup. Operator-authenticated via JWT.
 *      Body: { nodeId, servedModels[], baseUrl, capacity, metadata? }
 *      Response: { workerId, workerToken } -- workerToken is shown
 *      ONCE, the worker stores it locally + uses it for heartbeats.
 *      We store only the SHA-256 hash; plaintext never persists.
 *
 *   2. POST /v1/inference-workers/:id/heartbeat
 *      Called every 30-60s by the worker. Authenticated via Bearer
 *      workerToken (matched against stored hash). Updates lastHeartbeat
 *      so the router considers the worker fresh. Idempotent.
 *
 *   3. DELETE /v1/inference-workers/:id
 *      Operator opts a worker out gracefully — flips status to DRAINED
 *      so the router stops picking it but in-flight requests finish.
 *      Re-register to bring it back.
 *
 * Plus two read endpoints for visibility:
 *   - GET /v1/portal/node-runner/inference-workers
 *       Operator lists their own workers (JWT-authenticated).
 *   - GET /v1/admin/inference-workers
 *       Admin lists every worker for ops inspection.
 *
 * Cleanup: a worker with stale heartbeat (>5 min) gets auto-flipped to
 * DEGRADED by a background tick (E2.x follow-up; out of scope here).
 * Until then, the router's 90s heartbeat freshness filter handles
 * routing-time correctness.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'

// Hash a worker token with SHA-256. Compared via timingSafeEqual to
// resist timing attacks on the heartbeat path.
function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function tokensMatch(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, 'hex')
  const b = Buffer.from(hashToken(candidate), 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const registerSchema = z.object({
  // Node id the operator is running this worker on. The worker must
  // belong to a Node owned by the authenticated operator's NodeRunner.
  nodeId: z.string().min(1),
  // List of model ids this worker serves. Stored as a comma-separated
  // string on the row; the router splits + dedupes on lookup.
  servedModels: z.array(z.string().min(1)).min(1).max(64),
  // HTTP base URL the platform POSTs inference requests to. Must be
  // reachable from our egress (operator's reverse-proxy or tunnel).
  baseUrl: z.string().url(),
  // Max concurrent inferences. Defaults to 1 for safety; operators
  // bump this once they know their GPU's headroom.
  capacity: z.number().int().min(1).max(64).optional(),
  // Free-form: vLLM version, GPU model, VRAM, anything useful to
  // surface in admin tooling.
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const heartbeatSchema = z.object({
  // When set, signals the worker's current load. The router uses this
  // for capacity-aware routing. Optional — workers that don't track
  // their own load send heartbeat without a body.
  currentLoad: z.number().int().min(0).optional(),
  // Optional latency hint from the worker's own self-measurement.
  // Overrides nothing — the router updates p50LatencyMs from actual
  // observed latency on each stream close, not from worker self-report.
  status: z.enum(['READY', 'SERVING', 'DEGRADED', 'DRAINED']).optional(),
})

export async function inferenceWorkerRoutes(fastify: FastifyInstance) {
  // -----------------------------------------------------------------
  // POST /v1/inference-workers/register
  // -----------------------------------------------------------------
  fastify.post(
    '/v1/inference-workers/register',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parsed.error.errors.map((e) => e.message).join('; '),
        })
      }

      const userId = request.user?.userId
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

      // Verify the node belongs to this operator. Admin bypass keeps
      // support workflows simple.
      const node = await fastify.prisma.node.findUnique({
        where: { id: parsed.data.nodeId },
        select: { id: true, nodeRunner: { select: { userId: true } } },
      })
      if (!node) return reply.code(404).send({ error: 'Node not found' })

      const isAdmin = request.user?.role === 'ADMIN' || request.authType === 'admin'
      if (!isAdmin && node.nodeRunner?.userId !== userId) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'You do not own this node',
        })
      }

      // Mint a fresh worker token (32 bytes base64url = ~43 chars).
      // Store only the SHA-256 hash; surface the plaintext exactly
      // once in the response. The worker is responsible for saving
      // it locally; we cannot retrieve it after this call.
      const plainToken = randomBytes(32).toString('base64url')
      const tokenHash = hashToken(plainToken)

      const worker = await fastify.prisma.inferenceWorker.create({
        data: {
          nodeId: parsed.data.nodeId,
          servedModels: parsed.data.servedModels.join(','),
          baseUrl: parsed.data.baseUrl,
          authTokenHash: tokenHash,
          status: 'PENDING',
          capacity: parsed.data.capacity ?? 1,
          metadata: parsed.data.metadata
            ? (parsed.data.metadata as object)
            : undefined,
        },
      })

      reply.code(201).send({
        workerId: worker.id,
        workerToken: plainToken,
        heartbeatUrl: `/v1/inference-workers/${worker.id}/heartbeat`,
        nextSteps:
          'Save workerToken locally. POST to heartbeatUrl every 30-60s with Authorization: Bearer <workerToken>. Worker flips PENDING -> READY on the first successful heartbeat.',
      })
    },
  )

  // -----------------------------------------------------------------
  // POST /v1/inference-workers/:id/heartbeat
  // -----------------------------------------------------------------
  fastify.post('/v1/inference-workers/:id/heartbeat', async (request, reply) => {
    const { id } = request.params as { id: string }

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing bearer token' })
    }
    const token = auth.slice('Bearer '.length).trim()

    const worker = await fastify.prisma.inferenceWorker.findUnique({
      where: { id },
      select: { id: true, authTokenHash: true, status: true },
    })
    if (!worker) return reply.code(404).send({ error: 'Worker not found' })
    if (!tokensMatch(worker.authTokenHash, token)) {
      return reply.code(401).send({ error: 'Invalid worker token' })
    }

    const parsed = heartbeatSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      })
    }

    // Status promotion rules:
    //   PENDING -> READY on first successful heartbeat (worker is up)
    //   Subsequent heartbeats may bump to SERVING if worker reports
    //   in-flight load, or DEGRADED if worker self-reports a fault.
    //   DRAINED is terminal — once an operator calls DELETE, further
    //   heartbeats keep the row alive but don't flip it back to READY.
    let nextStatus = worker.status
    if (worker.status === 'PENDING') nextStatus = 'READY'
    if (parsed.data.status && worker.status !== 'DRAINED') {
      nextStatus = parsed.data.status
    } else if (
      worker.status !== 'DRAINED' &&
      typeof parsed.data.currentLoad === 'number'
    ) {
      nextStatus = parsed.data.currentLoad > 0 ? 'SERVING' : 'READY'
    }

    await fastify.prisma.inferenceWorker.update({
      where: { id },
      data: {
        lastHeartbeat: new Date(),
        status: nextStatus,
      },
    })

    reply.send({ ok: true, status: nextStatus })
  })

  // -----------------------------------------------------------------
  // DELETE /v1/inference-workers/:id  — operator graceful drain
  // -----------------------------------------------------------------
  fastify.delete(
    '/v1/inference-workers/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const userId = request.user?.userId

      const worker = await fastify.prisma.inferenceWorker.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          node: { select: { nodeRunner: { select: { userId: true } } } },
        },
      })
      if (!worker) return reply.code(404).send({ error: 'Worker not found' })

      const isAdmin = request.user?.role === 'ADMIN' || request.authType === 'admin'
      if (!isAdmin && worker.node.nodeRunner?.userId !== userId) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      await fastify.prisma.inferenceWorker.update({
        where: { id },
        data: { status: 'DRAINED' },
      })

      reply.send({ ok: true, status: 'DRAINED' })
    },
  )

  // -----------------------------------------------------------------
  // GET /v1/portal/node-runner/inference-workers — operator's own list
  // -----------------------------------------------------------------
  fastify.get(
    '/v1/portal/node-runner/inference-workers',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('NODE_RUNNER', 'ADMIN')],
    },
    async (request, reply) => {
      const userId = request.user!.userId
      const nodeRunner = await fastify.prisma.nodeRunner.findUnique({
        where: { userId },
        select: { id: true },
      })
      if (!nodeRunner) {
        return reply.send({ workers: [] })
      }

      const workers = await fastify.prisma.inferenceWorker.findMany({
        where: {
          node: { nodeRunnerId: nodeRunner.id },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          node: { select: { id: true, gpuTier: true, region: true } },
        },
      })

      reply.send({
        workers: workers.map((w) => ({
          id: w.id,
          nodeId: w.nodeId,
          gpuTier: w.node.gpuTier,
          region: w.node.region,
          servedModels: w.servedModels.split(',').map((s) => s.trim()),
          baseUrl: w.baseUrl,
          status: w.status,
          capacity: w.capacity,
          p50LatencyMs: w.p50LatencyMs,
          lastHeartbeat: w.lastHeartbeat,
          createdAt: w.createdAt,
        })),
      })
    },
  )

  // -----------------------------------------------------------------
  // GET /v1/admin/inference-workers — admin full list
  // -----------------------------------------------------------------
  fastify.get(
    '/v1/admin/inference-workers',
    {
      preHandler: [fastify.authenticate, fastify.requireRole('ADMIN')],
    },
    async (_request, reply) => {
      const workers = await fastify.prisma.inferenceWorker.findMany({
        orderBy: { lastHeartbeat: 'desc' },
        include: {
          node: {
            select: {
              id: true,
              gpuTier: true,
              region: true,
              nodeRunner: { select: { id: true, name: true } },
            },
          },
          _count: {
            select: {
              inferenceRequests: {
                where: { status: { in: ['ROUTING', 'STREAMING'] } },
              },
            },
          },
        },
      })

      reply.send({
        workers: workers.map((w) => ({
          id: w.id,
          nodeId: w.nodeId,
          operator: w.node.nodeRunner
            ? { id: w.node.nodeRunner.id, name: w.node.nodeRunner.name }
            : null,
          gpuTier: w.node.gpuTier,
          region: w.node.region,
          servedModels: w.servedModels.split(',').map((s) => s.trim()),
          baseUrl: w.baseUrl,
          status: w.status,
          capacity: w.capacity,
          currentInflight: w._count.inferenceRequests,
          p50LatencyMs: w.p50LatencyMs,
          lastHeartbeat: w.lastHeartbeat,
          createdAt: w.createdAt,
        })),
      })
    },
  )
}
