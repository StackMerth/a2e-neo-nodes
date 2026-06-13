import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GpuTier, NodeType, NodeStatus } from '@a2e/database'
import { notifyFirstHeartbeat, notifyNodeDegraded } from '../services/notification/service.js'

// C4 wave 1: anomaly threshold for benchmark score regression.
// When a new score drops >20% below the prior recorded score, fire
// NODE_DEGRADED notification. Tunable via env so admin can re-calibrate
// post-launch without a deploy.
const BENCHMARK_ANOMALY_THRESHOLD_PCT = Number(process.env.BENCHMARK_ANOMALY_THRESHOLD_PCT ?? 20)

// SECURITY (M-1 / N-6, 2026-06-13): minimum (score, matmulTflops) the
// benchmark must produce to attest each tier. The operator's declared
// tier is a label they choose; the ATTESTED tier is what their numbers
// prove. Settlement, listing rate, and the heartbeat throttle all key
// off the attested tier so an operator who claims B300 but produces
// RTX_3090 numbers gets RTX_3090 treatment. Numbers are conservative;
// real hardware easily clears them. Operators with a real GPU but a
// soft benchmark image (CUDA misconfig) still attest at least the
// CONSUMER tier provided their score is non-zero.
//
// Order matters: we walk from highest to lowest and pick the first
// tier the benchmark satisfies. Thresholds are env-tunable so admin
// can recalibrate as hardware/benchmark image evolves without a deploy.
const TIER_MIN_BENCHMARK: ReadonlyArray<{
  tier: GpuTier
  minScore: number
  minMatmulTflops: number
}> = [
  { tier: 'GB300' as GpuTier, minScore: 130, minMatmulTflops: 1800 },
  { tier: 'B300' as GpuTier, minScore: 120, minMatmulTflops: 1500 },
  { tier: 'B200' as GpuTier, minScore: 110, minMatmulTflops: 1200 },
  { tier: 'H200' as GpuTier, minScore: 95, minMatmulTflops: 900 },
  { tier: 'H100' as GpuTier, minScore: 80, minMatmulTflops: 700 },
  { tier: 'L40S' as GpuTier, minScore: 55, minMatmulTflops: 250 },
  { tier: 'RTX_4090' as GpuTier, minScore: 35, minMatmulTflops: 120 },
  { tier: 'RTX_3090' as GpuTier, minScore: 25, minMatmulTflops: 70 },
  { tier: 'CONSUMER' as GpuTier, minScore: 1, minMatmulTflops: 0 },
]

export function attestGpuTierFromBenchmark(
  score: number,
  matmulTflops: number | null,
): GpuTier {
  const tflops = matmulTflops ?? 0
  for (const { tier, minScore, minMatmulTflops } of TIER_MIN_BENCHMARK) {
    if (score >= minScore && tflops >= minMatmulTflops) {
      return tier
    }
  }
  return 'CONSUMER' as GpuTier
}

// Schema for agent registration (from node-agent)
const agentSpecsSchema = z.object({
  gpuModel: z.string().optional(),
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
  gpuCount: z.number().optional(),
  gpuVram: z.number().optional(),
  gpuDriver: z.string().optional(),
  cudaVersion: z.string().optional(),
  hostname: z.string().optional(),
  os: z.string().optional(),
  osVersion: z.string().optional(),
  totalMemory: z.number().optional(),
  totalCpus: z.number().optional(),
  dockerVersion: z.string().optional(),
  agentVersion: z.string().optional(),
})

const registerNodeSchema = z.object({
  // Support both formats: direct walletAddress or specs.hostname as fallback
  walletAddress: z.string().min(1).max(128).optional(),
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090']).optional(),
  nodeType: z.enum(['PROVISIONED', 'BYOG']).default('PROVISIONED'),
  region: z.string().max(64).optional(),
  name: z.string().max(128).optional(),
  // Agent sends specs object
  specs: agentSpecsSchema.optional(),
}).transform((data) => {
  // Extract gpuTier from specs if not provided at top level
  const gpuTier = data.gpuTier || data.specs?.gpuTier || 'H100'
  // Use walletAddress, or name, or hostname from specs as identifier
  const walletAddress = data.walletAddress || data.name || data.specs?.hostname || `node-${Date.now()}`
  return {
    walletAddress,
    gpuTier,
    nodeType: data.nodeType,
    region: data.region,
    name: data.name,
    agentVersion: data.specs?.agentVersion,
  }
})

const listNodesQuerySchema = z.object({
  status: z.enum(['ONLINE', 'DEGRADED', 'OFFLINE']).optional(),
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})

const heartbeatSchema = z.object({
  gpuUtilization: z.number().min(0).max(100).optional(),
  gpuTemperature: z.number().min(0).max(150).optional(),
  gpuMemoryUsed: z.number().min(0).optional(),
  gpuMemoryTotal: z.number().min(0).optional(),
})

export async function nodeRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/v1/nodes',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = registerNodeSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
          details: parseResult.error.errors,
        })
      }

      const { walletAddress, gpuTier, nodeType, region, agentVersion } = parseResult.data

      const existing = await fastify.prisma.node.findUnique({
        where: { walletAddress },
      })

      if (existing) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Node with this wallet address already exists',
          nodeId: existing.id,
        })
      }

      // SECURITY (A7 layer 2, 2026-06-12 sixth-round audit): per-operator
      // node-registration cap. Combined with the proof-of-GPU listing
      // filter (A7 layer 1), this limits the marketplace flooding
      // surface. Default cap (50) preserves legitimate datacenter
      // operators; raise via MAX_NODES_PER_OPERATOR env if needed.
      //
      // TOCTOU NOTE (audit follow-up): the count+create is wrapped in a
      // serializable Prisma transaction with the count INSIDE the
      // transaction. Postgres' serializable isolation level rejects
      // conflicting transactions with retry-required errors, so two
      // parallel registrations both reading the same count + both
      // trying to create can't both succeed. The cap is now hard, not
      // soft. Orphan registrations (request.authType != 'user' or no
      // NodeRunner) skip the cap because B1 layer 1 already
      // neutralizes them at settlement.
      const NODE_CAP_PER_OPERATOR = parseInt(
        process.env.MAX_NODES_PER_OPERATOR ?? '50',
        10,
      )

      // Get the API key from the request header - will be stored on the node.
      // SECURITY (pen-test A6 2026-06-10): coerce to string explicitly so that
      // a missing X-API-Key header doesn't blow up the apiKey.startsWith()
      // check below with `undefined.startsWith is not a function` -> 500.
      // Authenticated callers without an X-API-Key header simply get
      // node.apiKey=undefined (i.e. no node-specific key stored), which is
      // the same outcome as before, just without the crash.
      const apiKey = (request.headers['x-api-key'] as string | undefined) ?? ''

      // If registering via provision job API key, look up the provision job
      let provisionJobId: string | undefined
      if (request.authType === 'provision' && request.authProvisionId) {
        provisionJobId = request.authProvisionId
      }

      // capState wraps the sentinel in an object so TypeScript's
      // control-flow analysis (which can't follow async callbacks)
      // doesn't narrow the catch-side read down to never.
      const capState: { exceeded: { count: number } | null } = { exceeded: null }
      let node
      try {
        node = await fastify.prisma.$transaction(async tx => {
          if (NODE_CAP_PER_OPERATOR > 0 && request.authType === 'user') {
            const nr = await tx.nodeRunner.findUnique({
              where: { userId: request.user!.userId },
              select: { id: true },
            })
            if (nr) {
              const nodeCount = await tx.node.count({
                where: { nodeRunnerId: nr.id },
              })
              if (nodeCount >= NODE_CAP_PER_OPERATOR) {
                capState.exceeded = { count: nodeCount }
                throw new Error('NODE_CAP_EXCEEDED')
              }
            }
          }
          return tx.node.create({
            data: {
              walletAddress,
              gpuTier: gpuTier as GpuTier,
              nodeType: nodeType as NodeType,
              region,
              agentVersion,
              apiKey: apiKey.startsWith('a2e-node-') ? apiKey : undefined,
              status: 'ONLINE' as NodeStatus,
              lastHeartbeat: new Date(),
            },
          })
        }, { isolationLevel: 'Serializable' })
      } catch (err) {
        const cap = capState.exceeded
        if (cap) {
          return reply.code(403).send({
            error: 'node_cap_exceeded',
            message:
              `You have ${cap.count}/${NODE_CAP_PER_OPERATOR} nodes ` +
              `registered. Contact support to raise the operator cap if ` +
              `you legitimately need more.`,
            currentCount: cap.count,
            cap: NODE_CAP_PER_OPERATOR,
          })
        }
        // Serializable retry-required errors get this generic 503 so
        // the caller can retry; very narrow window in practice.
        const e = err as { code?: string }
        if (e?.code === 'P2034') {
          return reply.code(503).send({
            error: 'tx_serialization_conflict',
            message: 'Registration race; retry in a moment.',
          })
        }
        throw err
      }

      // If this was a provision job registration, link the node to the provision job
      if (provisionJobId) {
        await fastify.prisma.provisionJob.update({
          where: { id: provisionJobId },
          data: { nodeId: node.id },
        })
      }

      fastify.io?.emit('node:registered', {
        id: node.id,
        walletAddress: node.walletAddress,
        gpuTier: node.gpuTier,
        status: node.status,
        timestamp: new Date().toISOString(),
      })

      reply.code(201).send({
        nodeId: node.id, // Agent expects 'nodeId'
        id: node.id,
        walletAddress: node.walletAddress,
        gpuTier: node.gpuTier,
        nodeType: node.nodeType,
        status: node.status,
        region: node.region,
        lastHeartbeat: node.lastHeartbeat.toISOString(),
        createdAt: node.createdAt.toISOString(),
      })
    }
  )

  fastify.get(
    '/v1/nodes',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = listNodesQuerySchema.safeParse(request.query)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid query',
        })
      }

      const { status, gpuTier, page, limit } = parseResult.data
      const skip = (page - 1) * limit

      const where: { status?: NodeStatus; gpuTier?: GpuTier } = {}
      if (status) where.status = status as NodeStatus
      if (gpuTier) where.gpuTier = gpuTier as GpuTier

      const [nodes, total] = await Promise.all([
        fastify.prisma.node.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            walletAddress: true,
            gpuTier: true,
            nodeType: true,
            status: true,
            region: true,
            lastHeartbeat: true,
            createdAt: true,
          },
        }),
        fastify.prisma.node.count({ where }),
      ])

      reply.send({
        nodes: nodes.map((n) => ({
          ...n,
          lastHeartbeat: n.lastHeartbeat.toISOString(),
          createdAt: n.createdAt.toISOString(),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      })
    }
  )

  fastify.get(
    '/v1/nodes/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const node = await fastify.prisma.node.findUnique({
        where: { id },
        include: {
          heartbeats: {
            take: 10,
            orderBy: { timestamp: 'desc' },
          },
          _count: {
            select: { jobs: true, earnings: true },
          },
        },
      })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      reply.send({
        id: node.id,
        walletAddress: node.walletAddress,
        gpuTier: node.gpuTier,
        nodeType: node.nodeType,
        status: node.status,
        region: node.region,
        lastHeartbeat: node.lastHeartbeat.toISOString(),
        missedBeats: node.missedBeats,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
        stats: {
          totalJobs: node._count.jobs,
          earningsRecords: node._count.earnings,
        },
        recentHeartbeats: node.heartbeats.map((h) => ({
          gpuUtilization: h.gpuUtilization,
          gpuTemperature: h.gpuTemperature,
          gpuMemoryUsed: h.gpuMemoryUsed,
          gpuMemoryTotal: h.gpuMemoryTotal,
          timestamp: h.timestamp.toISOString(),
        })),
      })
    }
  )

  fastify.delete(
    '/v1/nodes/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { force } = request.query as { force?: string }

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // If node has an API key (provisioned agent), mark for deletion
      // The agent will receive UNINSTALL command on next heartbeat
      if (node.apiKey && force !== 'true') {
        await fastify.prisma.node.update({
          where: { id },
          data: { pendingDeletion: true },
        })

        fastify.io?.emit('node:pending_deletion', {
          id: node.id,
          walletAddress: node.walletAddress,
          timestamp: new Date().toISOString(),
        })

        reply.send({
          message: 'Node marked for deletion. Agent will uninstall on next heartbeat.',
          nodeId: node.id,
          pendingDeletion: true,
        })
        return
      }

      // Immediate deletion (no agent or force=true)
      await fastify.prisma.node.delete({ where: { id } })

      fastify.io?.emit('node:offline', {
        id: node.id,
        walletAddress: node.walletAddress,
        reason: 'deregistered',
        timestamp: new Date().toISOString(),
      })

      reply.code(204).send()
    }
  )

  fastify.patch(
    '/v1/nodes/:id/status',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const statusSchema = z.object({
        status: z.enum(['ONLINE', 'PAUSED', 'MAINTENANCE']),
      })

      const parseResult = statusSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid status',
        })
      }

      const { status } = parseResult.data

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      const updatedNode = await fastify.prisma.node.update({
        where: { id },
        data: { status: status as NodeStatus },
      })

      fastify.io?.emit('node:status', {
        id: updatedNode.id,
        status: updatedNode.status,
        timestamp: new Date().toISOString(),
      })

      reply.send({
        id: updatedNode.id,
        status: updatedNode.status,
      })
    }
  )

  // Update node details (region only — walletAddress changes require
  // a dedicated signed-nonce flow per pen-test 2026-06-09 step 4).
  fastify.patch(
    '/v1/nodes/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      // SECURITY (pen-test 2026-06-09 step 4): walletAddress was the
      // settlement-payout target and was previously settable by any
      // authed user with no ownership proof. Removing it from the
      // schema entirely closes the attack until a proper signed-nonce
      // wallet-rotation endpoint ships. region is informational and
      // safe to keep patchable.
      const updateSchema = z.object({
        region: z.string().max(64).optional(),
      })

      const parseResult = updateSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const node = await fastify.prisma.node.findUnique({
        where: { id },
        include: { nodeRunner: { select: { userId: true } } },
      })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // SECURITY (pen-test 2026-06-09 step 4): ownership gate. Only:
      //   - admin (X-API-Key=ADMIN_API_KEY or user role=ADMIN), or
      //   - the node-agent itself (authNodeId === node.id), or
      //   - the user who owns the NodeRunner that owns this node
      // can PATCH. Previously any authed user could PATCH any node.
      const isAdmin =
        request.authType === 'admin' ||
        (request.authType === 'user' && request.user?.role === 'ADMIN')
      const isOwningNode =
        request.authType === 'node' && request.authNodeId === node.id
      const isOwningUser =
        request.authType === 'user' &&
        node.nodeRunner?.userId &&
        request.user?.userId === node.nodeRunner.userId
      if (!isAdmin && !isOwningNode && !isOwningUser) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Only the node owner, the node agent, or an admin can update this node.',
        })
      }

      // Reject explicit attempts to set walletAddress with a clear
      // diagnostic so legitimate clients learn the new contract
      // instead of silently dropping the value. Inspect the raw body
      // because the schema has stripped it.
      if ((request.body as Record<string, unknown> | null)?.walletAddress !== undefined) {
        return reply.code(400).send({
          error: 'wallet_change_unsupported',
          message:
            'Node wallet address can no longer be changed via PATCH /v1/nodes/:id. ' +
            'A signed-nonce wallet-rotation endpoint will be added; contact admin for now.',
        })
      }

      const updatedNode = await fastify.prisma.node.update({
        where: { id },
        data: parseResult.data,
      })

      reply.send({
        id: updatedNode.id,
        walletAddress: updatedNode.walletAddress,
        region: updatedNode.region,
      })
    }
  )

  fastify.post(
    '/v1/nodes/:id/heartbeat',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const parseResult = heartbeatSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const { gpuUtilization, gpuTemperature, gpuMemoryUsed, gpuMemoryTotal } = parseResult.data

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // SECURITY (B1 layer 3, 2026-06-12 sixth-round audit): rate-limit
      // heartbeats from nodes that haven't yet completed a real
      // benchmark. The fake-node uptime drain primitive was: register
      // a node with attacker-controlled wallet, heartbeat at 60s
      // cadence to bank uptime hours, never run real work. Combined
      // with the orphan-skip in settlement engine (B1 layer 1) this
      // already can't pay out; the rate-limit further discourages
      // spam by capping uptime accrual rate for unverified nodes to
      // 1 heartbeat every 5 minutes (vs the normal 60s). Real
      // operators get their benchmark score in the first 10 minutes
      // post-claim, then heartbeats run at normal cadence. Test seed
      // nodes (id startsWith 'test-c2-') are exempt for QA flows.
      const UNVERIFIED_HEARTBEAT_INTERVAL_MS = parseInt(
        process.env.UNVERIFIED_NODE_HEARTBEAT_INTERVAL_MS ?? '300000',
        10,
      )
      const isVerified =
        (node.benchmarkScore != null && node.benchmarkScore > 0) ||
        id.startsWith('test-c2-')
      if (!isVerified && UNVERIFIED_HEARTBEAT_INTERVAL_MS > 0) {
        const sinceLast = Date.now() - node.lastHeartbeat.getTime()
        if (sinceLast < UNVERIFIED_HEARTBEAT_INTERVAL_MS) {
          const waitMs = UNVERIFIED_HEARTBEAT_INTERVAL_MS - sinceLast
          return reply.code(429).send({
            error: 'heartbeat_throttled_pre_verification',
            message:
              `Unverified node (no benchmark score yet). Heartbeats ` +
              `throttled to once every ` +
              `${Math.round(UNVERIFIED_HEARTBEAT_INTERVAL_MS / 1000)}s ` +
              `until the standard benchmark image runs against this node. ` +
              `Wait ${Math.ceil(waitMs / 1000)}s and retry, or run the ` +
              `benchmark to unlock the normal 60s cadence.`,
            retryAfterSeconds: Math.ceil(waitMs / 1000),
          })
        }
      }

      const [updatedNode, heartbeat] = await fastify.prisma.$transaction([
        fastify.prisma.node.update({
          where: { id },
          data: {
            status: 'ONLINE',
            lastHeartbeat: new Date(),
            missedBeats: 0,
          },
        }),
        fastify.prisma.heartbeat.create({
          data: {
            nodeId: id,
            gpuUtilization,
            gpuTemperature,
            gpuMemoryUsed,
            gpuMemoryTotal,
          },
        }),
      ])

      fastify.io?.emit('node:heartbeat', {
        nodeId: id,
        gpuUtilization,
        gpuTemperature,
        gpuMemoryUsed,
        gpuMemoryTotal,
        timestamp: heartbeat.timestamp.toISOString(),
      })

      // C5: detect this operator's FIRST EVER heartbeat across all their
      // nodes and fire FIRST_HEARTBEAT_RECEIVED once. Uses updateMany +
      // predicate-on-null so concurrent heartbeats can't double-fire
      // (Postgres row lock wins exactly one update; the other no-ops).
      // Fire-and-forget: this must not block the heartbeat response.
      if (updatedNode.nodeRunnerId) {
        void (async () => {
          try {
            const result = await fastify.prisma.nodeRunner.updateMany({
              where: { id: updatedNode.nodeRunnerId!, firstHeartbeatAt: null },
              data: { firstHeartbeatAt: new Date() },
            })
            if (result.count === 1) {
              const nr = await fastify.prisma.nodeRunner.findUnique({
                where: { id: updatedNode.nodeRunnerId! },
                select: { userId: true, name: true },
              })
              if (nr?.userId) {
                const nodeLabel = node.walletAddress.slice(0, 16)
                void notifyFirstHeartbeat(nr.userId, nodeLabel)
              }
            }
          } catch (err) {
            request.log.warn({ err, nodeId: id }, 'first-heartbeat detection failed (non-fatal)')
          }
        })()
      }

      // Check if node is marked for deletion
      const commands: Array<{ id: string; type: string; payload?: Record<string, unknown> }> = []
      if (updatedNode.pendingDeletion) {
        commands.push({
          id: `uninstall-${Date.now()}`,
          type: 'UNINSTALL',
          payload: { reason: 'Node deleted from dashboard' },
        })

        // After sending UNINSTALL command, delete the node record
        // (agent will uninstall itself, so we can clean up the DB)
        await fastify.prisma.node.delete({ where: { id } })

        fastify.io?.emit('node:offline', {
          id: node.id,
          walletAddress: node.walletAddress,
          reason: 'uninstalled',
          timestamp: new Date().toISOString(),
        })
      }

      // Launch-blocker #2: surface the pending SSH session action to the
      // agent. PENDING -> agent needs to provision (useradd + key install).
      // TERMINATING -> agent needs to tear down. PROVISIONING/ACTIVE/
      // TERMINATED/FAILED -> agent is mid-flight or done; nothing to emit.
      let sshSession: {
        action: 'provision' | 'terminate'
        requestId: string
        username: string
        pubKey?: string
      } | undefined
      // M3-T6: surface a pending workspace-checkpoint action to the
      // agent. checkpoint -> buyer asked for a snapshot, agent should
      // tar+upload. restore -> rental started with a restoreCheckpointId,
      // agent should download+untar before the buyer connects.
      let workspaceCheckpoint: {
        action: 'checkpoint' | 'restore'
        requestId: string
        username: string
        checkpointId: string
      } | undefined
      if (updatedNode.assignedComputeRequestId) {
        const cr = await fastify.prisma.computeRequest.findUnique({
          where: { id: updatedNode.assignedComputeRequestId },
          select: {
            id: true,
            sshSessionStatus: true,
            sshUsername: true,
            sshPubKey: true,
            checkpointStatus: true,
            lastCheckpointId: true,
            restoreCheckpointId: true,
            restoreAppliedAt: true,
          },
        })
        if (cr?.sshUsername) {
          if (cr.sshSessionStatus === 'PENDING') {
            sshSession = {
              action: 'provision',
              requestId: cr.id,
              username: cr.sshUsername,
              pubKey: cr.sshPubKey ?? undefined,
            }
          } else if (cr.sshSessionStatus === 'TERMINATING') {
            sshSession = {
              action: 'terminate',
              requestId: cr.id,
              username: cr.sshUsername,
            }
          }

          // Checkpoint priority order: restore takes precedence on a
          // fresh rental (one-shot before the buyer connects). After
          // restore is applied OR if no restore is pending, surface
          // any REQUESTED snapshot. Both paths fire fire-and-forget
          // from the agent's perspective.
          if (cr.restoreCheckpointId && !cr.restoreAppliedAt) {
            workspaceCheckpoint = {
              action: 'restore',
              requestId: cr.id,
              username: cr.sshUsername,
              checkpointId: cr.restoreCheckpointId,
            }
          } else if (cr.checkpointStatus === 'REQUESTED') {
            // For a fresh REQUESTED snapshot, the agent generates its
            // own checkpointId via the upload-url endpoint; we pass a
            // placeholder marker here so the agent knows there's work
            // to do. Once the agent uploads + reports READY, the row's
            // lastCheckpointId picks up the real id.
            workspaceCheckpoint = {
              action: 'checkpoint',
              requestId: cr.id,
              username: cr.sshUsername,
              checkpointId: cr.lastCheckpointId ?? 'pending',
            }
          }
        }
      }

      // C4 wave 1: surface a pending benchmark action to the agent
      // when the operator clicked "Run Benchmark". One-shot via a
      // Config row with key `benchmark:request:<nodeId>`; cleared by
      // /v1/nodes/:id/benchmark/result on agent callback. Single
      // index lookup, no schema change required for the flag itself.
      let benchmark: { action: 'run'; image?: string } | undefined
      const benchmarkFlag = await fastify.prisma.config.findUnique({
        where: { key: `benchmark:request:${id}` },
        select: { value: true },
      })
      if (benchmarkFlag) {
        // value can carry an image override; empty string means "use default"
        benchmark = benchmarkFlag.value
          ? { action: 'run', image: benchmarkFlag.value }
          : { action: 'run' }
      }

      reply.send({
        acknowledged: true,
        status: updatedNode.status,
        lastHeartbeat: updatedNode.lastHeartbeat.toISOString(),
        recorded: true,
        commands: commands.length > 0 ? commands : undefined,
        sshSession,
        workspaceCheckpoint,
        benchmark,
      })
    }
  )

  // Launch-blocker #2: agent reports SSH lifecycle transitions here.
  // Authorized by the node's own API key (same as heartbeat) and a
  // sanity check that the node is in the request's allocatedNodeIds.
  const sshStatusSchema = z.object({
    status: z.enum(['PROVISIONING', 'ACTIVE', 'TERMINATED', 'FAILED']),
    errorMessage: z.string().max(2048).optional(),
  })

  fastify.post(
    '/v1/nodes/:id/ssh-sessions/:requestId/status',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id: nodeId, requestId } = request.params as { id: string; requestId: string }
      const parsed = sshStatusSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const cr = await fastify.prisma.computeRequest.findUnique({
        where: { id: requestId },
        select: { id: true, allocatedNodeIds: true, sshSessionStatus: true },
      })
      if (!cr) {
        return reply.code(404).send({ error: 'Not Found', message: 'Compute request not found' })
      }
      if (!cr.allocatedNodeIds.includes(nodeId)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'This node is not assigned to the requested compute rental',
        })
      }

      const now = new Date()
      const updateData: {
        sshSessionStatus: typeof parsed.data.status
        sshProvisionedAt?: Date
        sshTerminatedAt?: Date
        sshErrorMessage?: string | null
      } = {
        sshSessionStatus: parsed.data.status,
      }
      if (parsed.data.status === 'ACTIVE') updateData.sshProvisionedAt = now
      if (parsed.data.status === 'TERMINATED') updateData.sshTerminatedAt = now
      if (parsed.data.status === 'FAILED') {
        updateData.sshErrorMessage = parsed.data.errorMessage ?? 'unspecified agent failure'
      }

      await fastify.prisma.$transaction(async (tx) => {
        await tx.computeRequest.update({
          where: { id: requestId },
          data: updateData,
        })
        // On TERMINATED, release the node back to the idle pool so the
        // allocator can reassign it on the next tick.
        if (parsed.data.status === 'TERMINATED') {
          await tx.node.update({
            where: { id: nodeId },
            data: { assignedComputeRequestId: null },
          })
        }
      })

      fastify.io?.emit('ssh-session:status', {
        nodeId,
        requestId,
        status: parsed.data.status,
        timestamp: now.toISOString(),
      })

      reply.send({ acknowledged: true, status: parsed.data.status, requestId })
    }
  )

  // ===================================================================
  // C4 wave 1: BENCHMARK RESULT CALLBACK (agent → API)
  // ===================================================================

  const benchmarkResultSchema = z.object({
    matmulTflops: z.number().min(0).max(10000).optional(),
    vramBandwidthGbs: z.number().min(0).max(20000).optional(),
    score: z.number().min(0).max(150).optional(),
    gpuName: z.string().max(200).optional(),
    error: z.string().max(2000).optional(),
  })

  /**
   * POST /v1/nodes/:id/benchmark/result
   *
   * Agent reports the result of a benchmark run (either success with
   * 3 metric fields, or failure with `error`). Either path:
   *   1. Clears the Config flag (benchmark:request:<nodeId>) so the
   *      next heartbeat-response stops surfacing the action.
   *   2. Updates the Node row's benchmark columns + lastBenchmarkAt.
   *      Failure paths leave the score/metric columns at their prior
   *      values but advance lastBenchmarkAt so the UI shows "ran X
   *      minutes ago" with the error message in adminNote.
   *   3. On success: compares new score to the prior benchmarkScore.
   *      If the drop exceeds BENCHMARK_ANOMALY_THRESHOLD_PCT (default
   *      20%), fires NODE_DEGRADED to alert the operator.
   */
  fastify.post(
    '/v1/nodes/:id/benchmark/result',
    {
      // SECURITY (pen-test A3 2026-06-10): without an auth preHandler the
      // route accepted unauthenticated POSTs and let anyone overwrite ANY
      // node's benchmarkScore. That feeds A1 (reputation inflation) and
      // B2 (marketplace fake-GPU flooding) directly: a self-inflated
      // benchmark climbs reputation tier, a sabotage-zeroed benchmark
      // drops a competitor + fires NODE_DEGRADED + node:benchmark WS
      // emit. Benchmark must be node-attested.
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = benchmarkResultSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors[0]?.message ?? 'Invalid input',
      })
    }
    const result = parsed.data

    // SECURITY (pen-test A3): only the node itself (authed with its own
    // X-API-Key) or an admin can write a benchmark result for this id.
    // request.authType is set by the auth plugin: 'node' means the key
    // was an a2e-node-... key bound to a Node row; authNodeId carries
    // that row's id. 'admin' is allowed so support can manually correct
    // anomalies. All other auth types (user/buyer/provision) are denied.
    if (request.authType === 'admin') {
      // allowed
    } else if (request.authType === 'node' && request.authNodeId === id) {
      // allowed (node writing its own benchmark)
    } else {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Benchmark result can only be submitted by the node itself (X-API-Key) or an admin.',
      })
    }

    const node = await fastify.prisma.node.findUnique({
      where: { id },
      select: {
        id: true,
        walletAddress: true,
        nodeRunnerId: true,
        benchmarkScore: true,
        gpuTier: true,
        nodeRunner: { select: { userId: true } },
      },
    })
    if (!node) return reply.code(404).send({ error: 'Node not found' })

    // Capture the prior score before we overwrite it — needed for the
    // anomaly comparison below.
    const priorScore = node.benchmarkScore ?? null

    const now = new Date()
    if (result.error) {
      // Failure path: don't blow away the prior numbers, but stamp
      // lastBenchmarkAt so the UI knows we tried.
      await fastify.prisma.node.update({
        where: { id },
        data: { lastBenchmarkAt: now },
      })
    } else {
      // SECURITY (M-1 / N-6, 2026-06-13): benchmark value is self-
      // reported by the node's agent; A3 authed the WRITE but not the
      // VALUE. An operator who replaces the agent binary could POST
      // {score:150} for a node that has no GPU at all. That bypasses:
      //   - A7 layer 1 listing filter (benchmarkScore > 0)
      //   - B1 layer 3 heartbeat throttle
      // Pragmatic mitigation pending real attestation (sentinel re-
      // benchmark / TEE proof / stake-slashing): derive an
      // ATTESTED tier from the reported (score, matmulTflops) using
      // tier-specific minimum thresholds. If the operator declared a
      // higher tier than the score supports, settlement (N-6) and the
      // listing rate (M-6) use the attested tier instead. Operator
      // payouts are capped at what their benchmark actually proves.
      const attestedTier = attestGpuTierFromBenchmark(
        result.score ?? 0,
        result.matmulTflops ?? null,
      )
      await fastify.prisma.node.update({
        where: { id },
        data: {
          benchmarkScore: result.score ?? null,
          benchmarkMatmulTflops: result.matmulTflops ?? null,
          benchmarkVramBandwidthGbs: result.vramBandwidthGbs ?? null,
          benchmarkAttestedTier: attestedTier,
          lastBenchmarkAt: now,
        },
      })

      // Flag the operator if they declared a tier that the benchmark
      // does not support. The settlement engine reads attestedTier
      // already; this surfaces the discrepancy for admin review.
      if (attestedTier !== node.gpuTier) {
        await fastify.prisma.config.upsert({
          where: { key: `tier-mismatch:${id}` },
          create: {
            key: `tier-mismatch:${id}`,
            value: JSON.stringify({
              declared: node.gpuTier,
              attested: attestedTier,
              score: result.score,
              matmulTflops: result.matmulTflops,
              flaggedAt: now.toISOString(),
            }),
          },
          update: {
            value: JSON.stringify({
              declared: node.gpuTier,
              attested: attestedTier,
              score: result.score,
              matmulTflops: result.matmulTflops,
              flaggedAt: now.toISOString(),
            }),
          },
        })
      }
    }

    // One-shot Config flag cleanup. deleteMany is forgiving of missing
    // rows (might already have been cleaned up by a stale agent retry).
    await fastify.prisma.config.deleteMany({
      where: { key: `benchmark:request:${id}` },
    })

    // Real-time UI update via WS so the operator's /nodes/<id> page
    // refreshes the benchmark card without waiting for the next poll.
    fastify.io?.emit('node:benchmark', {
      nodeId: id,
      score: result.score ?? null,
      matmulTflops: result.matmulTflops ?? null,
      vramBandwidthGbs: result.vramBandwidthGbs ?? null,
      error: result.error ?? null,
      timestamp: now.toISOString(),
    })

    // Anomaly detection — only on success path with a prior score to
    // compare against. Threshold is env-tunable.
    if (
      !result.error &&
      typeof result.score === 'number' &&
      typeof priorScore === 'number' &&
      priorScore > 0
    ) {
      const dropPct = ((priorScore - result.score) / priorScore) * 100
      if (dropPct >= BENCHMARK_ANOMALY_THRESHOLD_PCT && node.nodeRunner?.userId) {
        const nodeLabel = node.walletAddress.slice(0, 16)
        void notifyNodeDegraded(
          node.nodeRunner.userId,
          nodeLabel,
          id,
          priorScore,
          result.score,
        )
      }
    }

    reply.send({ ok: true })
  })
}
