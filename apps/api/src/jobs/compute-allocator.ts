/**
 * M2 / B1: Auto-allocator worker (the operator-killer).
 *
 * Watches every PENDING ComputeRequest where the buyer's payment has
 * confirmed on-chain (txConfirmed=true) and decides what happens next:
 *
 *   1. Run eligibility rules. If held, set status=WAITLISTED and write
 *      flags so the admin Needs Review queue knows why. Stop here.
 *
 *   2. Find idle internal nodes matching the requested GPU tier. If
 *      supply is insufficient, leave the request in PENDING — the next
 *      tick retries automatically when nodes come online.
 *
 *   3. Mint an ephemeral SSH session token, mark the nodes assigned,
 *      transition the request to ALLOCATED, set ratePerMinute (so the
 *      per-minute meter has its multiplier ready), notify the buyer,
 *      and emit a websocket event so the dashboard updates live.
 *
 * The worker runs on a 10-second cadence. That's the worst-case latency
 * a buyer sees between paying and getting SSH access; in practice the
 * Solana webhook (M2.3) flips txConfirmed within ~3s of the on-chain
 * confirmation, so end-to-end pay-to-prompt is sub-15s.
 *
 * Idempotency: every status transition uses an updateMany with a status
 * predicate so two concurrent ticks can never double-allocate the same
 * request. If a tick races, one wins, the other no-ops.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient, ComputeRequest, User } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { evaluateEligibility } from '../services/allocation/eligibility.js'
import { mintSshSession } from '../services/allocation/ssh-session.js'
import { createNotification } from '../services/notification/service.js'

type ComputeRequestWithUser = ComputeRequest & { user: User }

const QUEUE_NAME = 'compute-allocator'
const TICK_INTERVAL_MS = parseInt(process.env.ALLOCATOR_TICK_MS ?? '10000', 10)

// How many candidate requests to evaluate per tick. Plenty of headroom
// for normal traffic; if backlog builds we'll see it in metrics and can
// raise this or shorten the tick interval.
const BATCH_SIZE = 25

// Heartbeat freshness threshold for "idle" nodes. Same value the admin
// auto-allocate route uses (apps/api/src/routes/admin-compute.ts:126)
// so manual and automatic paths see the same node pool.
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000

interface AllocatorDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createComputeAllocatorQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1, // retries handled by the next tick, not BullMQ
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  })
}

export function createComputeAllocatorWorker(deps: AllocatorDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runAllocatorTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1, // single-flight; we never want two ticks racing
    },
  )
}

export async function scheduleComputeAllocator(queue: Queue): Promise<void> {
  // Clear any prior repeatable so we don't accumulate them across deploys
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick logic — exported for tests
// ---------------------------------------------------------------------------

export async function runAllocatorTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  const candidates = await prisma.computeRequest.findMany({
    where: {
      status: 'PENDING',
      txConfirmed: true,
    },
    orderBy: { requestedAt: 'asc' }, // FIFO so first paid = first served
    take: BATCH_SIZE,
    include: { user: true },
  })

  for (const cr of candidates) {
    try {
      await processRequest(prisma, io, cr)
    } catch (err) {
      // One bad row must not poison the batch. Log and continue.
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] failed on request ${cr.id}:`, err)
    }
  }
}

async function processRequest(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<void> {
  // Step 1: eligibility
  const verdict = await evaluateEligibility(prisma, cr, cr.user)

  if (!verdict.approved) {
    // Atomic transition to WAITLISTED with status guard.
    const result = await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        status: 'WAITLISTED',
        eligibilityFlags: verdict.flags,
        adminNote: verdict.reason,
      },
    })
    if (result.count > 0) {
      void createNotification(
        cr.userId,
        'COMPUTE_REQUEST_HELD',
        'Request Under Review',
        `Your ${cr.gpuCount}x ${cr.gpuTier} request is being reviewed by the team. You'll get an update shortly.`,
      )
      io.emit('compute:waitlisted', {
        requestId: cr.id,
        userId: cr.userId,
        flags: verdict.flags,
        timestamp: new Date().toISOString(),
      })
    }
    return
  }

  // Step 2: pick idle nodes matching the tier
  const idleNodes = await prisma.node.findMany({
    where: {
      gpuTier: cr.gpuTier,
      status: 'ONLINE',
      currentJobId: null,
      assignedComputeRequestId: null,
      pendingDeletion: false,
      agentVersion: { not: null },
      lastHeartbeat: { gte: new Date(Date.now() - HEARTBEAT_FRESH_MS) },
    },
    orderBy: { lastHeartbeat: 'desc' },
    take: cr.gpuCount,
    select: { id: true, walletAddress: true },
  })

  if (idleNodes.length < cr.gpuCount) {
    // Insufficient supply — stay in PENDING, retry next tick. We don't
    // mark anything; the request stays exactly where it was. We do
    // record an eligibility flag so admin can see the request is paid
    // and waiting on capacity.
    await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        eligibilityFlags: [...verdict.flags, 'WAITING_ON_CAPACITY'],
      },
    })
    return
  }

  // Step 3: allocate atomically
  const nodeIds = idleNodes.map(n => n.id)
  const headNodeId = nodeIds[0]
  if (!headNodeId) {
    // Shouldn't happen — we just checked length above — but the type
    // system needs the guard to narrow nodeIds[0] from `string | undefined`.
    return
  }
  const session = mintSshSession(cr.durationDays)
  // ratePerDay is the per-GPU daily rate. The full-rental per-minute rate
  // (what the meter multiplies minutesUsed against) is gpuCount-scaled so
  // accruedCost moves at the same rate as the upfront commitment burns
  // down — early-termination refund = totalCost - accruedCost stays clean.
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)

  // SSH connection details live on the Investment that provisioned each
  // node (Node model doesn't carry sshHost/sshPort itself). Look up the
  // first allocated node's Investment to use as the rental's entrypoint;
  // multi-node clusters get a head-node entrypoint in M4.
  const headInvestment = await prisma.investment.findFirst({
    where: { nodeId: headNodeId },
    select: { sshHost: true, sshPort: true, sshUsername: true },
  })

  // Use a transaction so node assignment and request transition land
  // together. If the request status guard fails (someone else won the
  // race), the node update is rolled back too.
  const allocated = await prisma.$transaction(async tx => {
    const updated = await tx.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        status: 'ALLOCATED',
        approvedAt: cr.approvedAt ?? new Date(),
        allocatedAt: new Date(),
        allocatedNodeIds: nodeIds,
        allocationMethod: 'auto',
        eligibilityFlags: verdict.flags,
        ratePerMinute,
        sshSessionToken: session.token,
        sshSessionTokenExpiresAt: session.expiresAt,
        // SSH entrypoint comes from the first allocated node's Investment.
        // sshUsername defaults to 'a2e-buyer' (the short-term unix account
        // the agent creates per session); sshHost/sshPort fall back to
        // the Investment's record if known.
        sshHost: headInvestment?.sshHost ?? null,
        sshPort: headInvestment?.sshPort ?? 22,
        sshUsername: 'a2e-buyer',
      },
    })
    if (updated.count === 0) {
      // Lost the race; abort the transaction so nodes stay free
      throw new Error('AllocationRaceLost')
    }

    await tx.node.updateMany({
      where: { id: { in: nodeIds }, assignedComputeRequestId: null },
      data: { assignedComputeRequestId: cr.id },
    })
    return true
  }).catch((err: Error) => {
    if (err.message === 'AllocationRaceLost') return false
    throw err
  })

  if (!allocated) return

  void createNotification(
    cr.userId,
    'COMPUTE_ALLOCATED',
    'Compute Allocated',
    `Your ${cr.gpuCount}x ${cr.gpuTier} compute is ready. SSH details are in your dashboard.`,
  )

  io.emit('compute:allocated', {
    requestId: cr.id,
    userId: cr.userId,
    nodeIds,
    timestamp: new Date().toISOString(),
  })
}
