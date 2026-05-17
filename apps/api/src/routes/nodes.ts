import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GpuTier, NodeType, NodeStatus } from '@a2e/database'
import { notifyFirstHeartbeat } from '../services/notification/service.js'

// Schema for agent registration (from node-agent)
const agentSpecsSchema = z.object({
  gpuModel: z.string().optional(),
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER']),
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
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER']).optional(),
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
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']).optional(),
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

      // Get the API key from the request header - will be stored on the node
      const apiKey = request.headers['x-api-key'] as string

      // If registering via provision job API key, look up the provision job
      let provisionJobId: string | undefined
      if (request.authType === 'provision' && request.authProvisionId) {
        provisionJobId = request.authProvisionId
      }

      const node = await fastify.prisma.node.create({
        data: {
          walletAddress,
          gpuTier: gpuTier as GpuTier,
          nodeType: nodeType as NodeType,
          region,
          agentVersion,
          apiKey: apiKey.startsWith('a2e-node-') ? apiKey : undefined, // Only store node-specific keys
          status: 'ONLINE' as NodeStatus,
          lastHeartbeat: new Date(),
        },
      })

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

  // Update node details (wallet address, region, etc.)
  fastify.patch(
    '/v1/nodes/:id',
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const updateSchema = z.object({
        walletAddress: z.string().min(1).max(128).optional(),
        region: z.string().max(64).optional(),
      })

      const parseResult = updateSchema.safeParse(request.body)

      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Validation Error',
          message: parseResult.error.errors[0]?.message ?? 'Invalid input',
        })
      }

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

      // Check if new wallet address is already taken by another node
      if (parseResult.data.walletAddress && parseResult.data.walletAddress !== node.walletAddress) {
        const existing = await fastify.prisma.node.findUnique({
          where: { walletAddress: parseResult.data.walletAddress },
        })
        if (existing) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Wallet address already in use by another node',
          })
        }
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

      reply.send({
        acknowledged: true,
        status: updatedNode.status,
        lastHeartbeat: updatedNode.lastHeartbeat.toISOString(),
        recorded: true,
        commands: commands.length > 0 ? commands : undefined,
        sshSession,
        workspaceCheckpoint,
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
}
