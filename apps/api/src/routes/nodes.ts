import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { GpuTier, NodeType, NodeStatus } from '@a2e/database'

const registerNodeSchema = z.object({
  walletAddress: z.string().min(10).max(128),
  gpuTier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300']),
  nodeType: z.enum(['PROVISIONED', 'BYOG']).default('BYOG'),
  region: z.string().max(64).optional(),
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

      const { walletAddress, gpuTier, nodeType, region } = parseResult.data

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

      const node = await fastify.prisma.node.create({
        data: {
          walletAddress,
          gpuTier: gpuTier as GpuTier,
          nodeType: nodeType as NodeType,
          region,
          status: 'ONLINE' as NodeStatus,
          lastHeartbeat: new Date(),
        },
      })

      fastify.io?.emit('node:registered', {
        id: node.id,
        walletAddress: node.walletAddress,
        gpuTier: node.gpuTier,
        status: node.status,
        timestamp: new Date().toISOString(),
      })

      reply.code(201).send({
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

      const node = await fastify.prisma.node.findUnique({ where: { id } })

      if (!node) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Node not found',
        })
      }

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

      reply.send({
        status: updatedNode.status,
        lastHeartbeat: updatedNode.lastHeartbeat.toISOString(),
        recorded: true,
      })
    }
  )
}
