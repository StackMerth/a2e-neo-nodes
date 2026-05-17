import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createNotification } from '../services/notification/service.js'

const allocateSchema = z.object({
  nodeIds: z.array(z.string()).min(1),
  sshHost: z.string().min(1),
  sshPort: z.number().int().default(22),
  sshUsername: z.string().min(1),
  sshPassword: z.string().min(1),
})

export async function adminComputeRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  /**
   * GET /v1/admin/compute/requests — List all compute requests
   */
  fastify.get('/v1/admin/compute/requests', async (request, reply) => {
    const status = (request.query as { status?: string }).status

    const where: Record<string, unknown> = {}
    if (status) where.status = status

    const requests = await fastify.prisma.computeRequest.findMany({
      where,
      include: { user: { select: { id: true, email: true, walletAddress: true } } },
      orderBy: { requestedAt: 'desc' },
    })

    const counts = {
      pending: await fastify.prisma.computeRequest.count({ where: { status: 'PENDING' } }),
      approved: await fastify.prisma.computeRequest.count({ where: { status: 'APPROVED' } }),
      active: await fastify.prisma.computeRequest.count({ where: { status: 'ACTIVE' } }),
      completed: await fastify.prisma.computeRequest.count({ where: { status: 'COMPLETED' } }),
      // M2: WAITLISTED is the auto-allocator's hold queue. Surfaced
      // separately so the admin dashboard can show a "Needs Review"
      // chip with a real count.
      waitlisted: await fastify.prisma.computeRequest.count({ where: { status: 'WAITLISTED' } }),
      // M2: 'terminated' is the subset of COMPLETED rentals that ended
      // via buyer-initiated early terminate (vs auto-expiry). Identified
      // by the adminNote prefix the terminate route writes. Lets the
      // admin dashboard show a 'Terminated' filter pill with a real
      // count without doing a second API round-trip.
      terminated: await fastify.prisma.computeRequest.count({
        where: { status: 'COMPLETED', adminNote: { startsWith: 'Buyer terminated' } },
      }),
    }

    reply.send({ requests, counts })
  })

  /**
   * POST /v1/admin/compute/requests/:id/release-hold
   *
   * M2: admin-side override that flips a WAITLISTED request back to
   * PENDING so the auto-allocator picks it up on the next 10s tick.
   * Use this when the admin reviewed the eligibility flags and
   * decided the buyer can proceed (e.g. cleared a "first-time over
   * ceiling" hold after vetting them).
   */
  fastify.post('/v1/admin/compute/requests/:id/release-hold', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { note } = (request.body as { note?: string }) || {}

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'WAITLISTED') {
      return reply.code(400).send({ error: `Cannot release hold: status is ${cr.status}` })
    }

    // Append MANUAL_REVIEW_PASSED so the allocator's eligibility check
    // bypasses the same HOLD_ rules that fired here. Without this, the
    // very next 10s tick would re-fire the rules (buyer is still
    // first-time, totalCost still > ceiling) and bounce the request
    // straight back to WAITLISTED — making Release Hold useless.
    const existingFlags = (cr.eligibilityFlags ?? []).filter(f => !f.startsWith('HOLD_'))
    const newFlags = Array.from(new Set([...existingFlags, 'MANUAL_REVIEW_PASSED']))

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: {
        status: 'PENDING',
        eligibilityFlags: newFlags,
        adminNote: note ?? `Released from hold by admin at ${new Date().toISOString()}`,
      },
    })

    void createNotification(
      cr.userId,
      'COMPUTE_REQUEST_APPROVED',
      'Request Reviewed',
      'Your compute request has been reviewed and is now being allocated.',
      `/buyer/requests/${id}`,
    )

    reply.send({ id, status: 'PENDING' })
  })

  /**
   * GET /v1/admin/compute/requests/:id
   */
  fastify.get('/v1/admin/compute/requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const cr = await fastify.prisma.computeRequest.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, walletAddress: true } } },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    reply.send({ request: cr })
  })

  /**
   * GET /v1/admin/compute/availability — Check internal node availability
   */
  fastify.get('/v1/admin/compute/availability', async (request, reply) => {
    const gpuTiers = ['H100', 'H200', 'B200', 'B300', 'GB300'] as const

    const availability: Record<string, { total: number; idle: number; busy: number }> = {}

    // Only count nodes with a real agent (agentVersion set) and recent heartbeat (< 2 min)
    const heartbeatThreshold = new Date(Date.now() - 2 * 60 * 1000)

    for (const tier of gpuTiers) {
      const total = await fastify.prisma.node.count({
        where: {
          gpuTier: tier,
          status: { in: ['ONLINE', 'PAUSED'] },
          agentVersion: { not: null },
          lastHeartbeat: { gte: heartbeatThreshold },
          pendingDeletion: false,
        },
      })
      const busy = await fastify.prisma.node.count({
        where: {
          gpuTier: tier,
          status: 'ONLINE',
          agentVersion: { not: null },
          lastHeartbeat: { gte: heartbeatThreshold },
          currentJobId: { not: null },
        },
      })
      availability[tier] = { total, idle: total - busy, busy }
    }

    reply.send({ availability })
  })

  /**
   * PATCH /v1/admin/compute/requests/:id/approve
   */
  fastify.patch('/v1/admin/compute/requests/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { note } = (request.body as { note?: string }) || {}

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'PENDING') return reply.code(400).send({ error: `Cannot approve: status is ${cr.status}` })

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date(), adminNote: note },
    })

    void createNotification(cr.userId, 'COMPUTE_REQUEST_APPROVED', 'Request Approved',
      `Your ${cr.gpuCount}x ${cr.gpuTier} compute request has been approved.`,
      `/buyer/requests/${id}`)

    reply.send({ id, status: 'APPROVED' })
  })

  /**
   * POST /v1/admin/compute/requests/:id/auto-allocate
   * Automatically find idle internal nodes matching the GPU tier and assign them
   */
  fastify.post('/v1/admin/compute/requests/:id/auto-allocate', async (request, reply) => {
    const { id } = request.params as { id: string }

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (!['PENDING', 'APPROVED'].includes(cr.status)) {
      return reply.code(400).send({ error: `Cannot allocate: status is ${cr.status}` })
    }

    // Find idle internal nodes with a real running agent
    const heartbeatThreshold = new Date(Date.now() - 2 * 60 * 1000)
    const idleNodes = await fastify.prisma.node.findMany({
      where: {
        gpuTier: cr.gpuTier,
        status: 'ONLINE',
        currentJobId: null,
        pendingDeletion: false,
        agentVersion: { not: null },
        lastHeartbeat: { gte: heartbeatThreshold },
      },
      orderBy: { lastHeartbeat: 'desc' },
      take: cr.gpuCount,
      select: { id: true, walletAddress: true },
    })

    if (idleNodes.length < cr.gpuCount) {
      return reply.code(409).send({
        error: 'Insufficient Supply',
        message: `Need ${cr.gpuCount} idle ${cr.gpuTier} nodes but only ${idleNodes.length} available`,
        available: idleNodes.length,
        required: cr.gpuCount,
      })
    }

    const nodeIds = idleNodes.map(n => n.id)

    // Get SSH details from the first allocated node (or use a proxy)
    // For bare metal, admin may still need to provide SSH details separately
    // Auto-allocate assigns the nodes, admin provides SSH in a follow-up or activation step

    // Mark the allocated nodes as assigned to this compute request
    await fastify.prisma.node.updateMany({
      where: { id: { in: nodeIds } },
      data: { assignedComputeRequestId: id },
    })

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: {
        status: 'APPROVED', // Stays APPROVED — admin needs to provide SSH and activate
        approvedAt: cr.approvedAt ?? new Date(),
        allocatedNodeIds: nodeIds,
        allocationMethod: 'auto',
        adminNote: `Auto-allocated ${nodeIds.length} nodes: ${nodeIds.join(', ')}`,
      },
    })

    void createNotification(cr.userId, 'COMPUTE_REQUEST_APPROVED', 'Request Approved',
      `Your ${cr.gpuCount}x ${cr.gpuTier} compute request has been approved. Nodes are being prepared.`,
      `/buyer/requests/${id}`)

    reply.send({
      id, status: 'APPROVED',
      allocatedNodes: nodeIds,
      allocationMethod: 'auto',
      message: `${nodeIds.length} nodes auto-allocated. Provide SSH details and activate.`,
    })
  })

  /**
   * PATCH /v1/admin/compute/requests/:id/allocate — Manual allocation with SSH details
   */
  fastify.patch('/v1/admin/compute/requests/:id/allocate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = allocateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (!['PENDING', 'APPROVED'].includes(cr.status)) {
      return reply.code(400).send({ error: `Cannot allocate: status is ${cr.status}` })
    }

    const { nodeIds, sshHost, sshPort, sshUsername, sshPassword } = parsed.data

    // Mark the allocated nodes as assigned to this compute request
    await fastify.prisma.node.updateMany({
      where: { id: { in: nodeIds } },
      data: { assignedComputeRequestId: id },
    })

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: {
        status: 'ALLOCATED',
        approvedAt: cr.approvedAt ?? new Date(),
        allocatedAt: new Date(),
        allocatedNodeIds: nodeIds,
        allocationMethod: 'manual',
        sshHost, sshPort, sshUsername, sshPassword,
      },
    })

    void createNotification(cr.userId, 'COMPUTE_ALLOCATED', 'Compute Allocated',
      `Your ${cr.gpuCount}x ${cr.gpuTier} compute has been allocated and is being prepared.`,
      `/buyer/requests/${id}`)

    reply.send({ id, status: 'ALLOCATED' })
  })

  /**
   * PATCH /v1/admin/compute/requests/:id/activate — Make compute accessible to buyer
   */
  fastify.patch('/v1/admin/compute/requests/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string }

    // Allow providing SSH details during activation too
    const body = request.body as { sshHost?: string; sshPort?: number; sshUsername?: string; sshPassword?: string } | undefined

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (!['APPROVED', 'ALLOCATED'].includes(cr.status)) {
      return reply.code(400).send({ error: `Cannot activate: status is ${cr.status}` })
    }

    // SSH details must exist (either from allocation or provided now)
    const sshHost = body?.sshHost ?? cr.sshHost
    const sshPort = body?.sshPort ?? cr.sshPort
    const sshUsername = body?.sshUsername ?? cr.sshUsername
    const sshPassword = body?.sshPassword ?? cr.sshPassword

    if (!sshHost || !sshUsername || !sshPassword) {
      return reply.code(400).send({ error: 'SSH details required. Allocate first or provide in body.' })
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        activatedAt: now,
        expiresAt,
        sshHost, sshPort: sshPort ?? 22, sshUsername, sshPassword,
      },
    })

    void createNotification(cr.userId, 'COMPUTE_ACTIVE', 'Compute is Live!',
      `Your ${cr.gpuCount}x ${cr.gpuTier} compute is now active. SSH access details are available in your dashboard.`,
      `/buyer/requests/${id}`)

    // Emit WebSocket event
    fastify.io?.emit('compute:activated', { requestId: id, userId: cr.userId, timestamp: now.toISOString() })

    reply.send({ id, status: 'ACTIVE', expiresAt: expiresAt.toISOString() })
  })

  /**
   * PATCH /v1/admin/compute/requests/:id/reject
   */
  fastify.patch('/v1/admin/compute/requests/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { reason } = (request.body as { reason?: string }) || {}

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (!['PENDING', 'WAITLISTED'].includes(cr.status)) {
      return reply.code(400).send({ error: `Cannot reject: status is ${cr.status}` })
    }

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: { status: 'REJECTED', adminNote: reason },
    })

    void createNotification(cr.userId, 'COMPUTE_REJECTED', 'Request Rejected',
      reason ? `Your compute request was rejected: ${reason}` : 'Your compute request was rejected.',
      `/buyer/requests/${id}`)

    reply.send({ id, status: 'REJECTED' })
  })

  /**
   * PATCH /v1/admin/compute/requests/:id/complete — End compute lease
   */
  fastify.patch('/v1/admin/compute/requests/:id/complete', async (request, reply) => {
    const { id } = request.params as { id: string }

    const cr = await fastify.prisma.computeRequest.findUnique({ where: { id } })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'ACTIVE') return reply.code(400).send({ error: `Cannot complete: status is ${cr.status}` })

    // Clear assignedComputeRequestId on nodes that were allocated to this request
    await fastify.prisma.node.updateMany({
      where: { assignedComputeRequestId: id },
      data: { assignedComputeRequestId: null },
    })

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })

    void createNotification(cr.userId, 'COMPUTE_COMPLETED', 'Compute Lease Ended',
      `Your ${cr.gpuCount}x ${cr.gpuTier} compute lease has ended.`,
      `/buyer/requests/${id}`)

    reply.send({ id, status: 'COMPLETED' })
  })
}
