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
import { planClusterMesh } from '../services/provisioning/wireguard-mesh.js'

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
  //
  // M3: soft tiebreak chain when multiple nodes pass the hard filter:
  //   1. Higher operator reputationScore wins (NodeRunner relation)
  //      → PLATINUM (90+) operators picked over BRONZE (<60)
  //   2. Most recent heartbeat wins (existing M2 behavior)
  //
  // Implementation note: Prisma 5's orderBy only accepts the
  // {sort,nulls} form on direct scalar fields, not relation hops.
  // And Postgres's default NULLS FIRST for DESC would put nodes
  // without a NodeRunner at the top — exactly the wrong order.
  //
  // Workaround: fetch a wider candidate pool ordered by heartbeat
  // freshness (the cheap-to-index sort), then sort by reputation
  // in JS with explicit nulls-last handling, then slice to the
  // count we need. Pool size of max(gpuCount * 5, 20) gives enough
  // headroom that the top-N picks are still the truly best nodes.
  const PICK_POOL = Math.max(cr.gpuCount * 5, 20)
  // M4.4: hard-filter on region when the buyer specified one. Null
  // requiredRegion means "Any" (default) and the where clause skips
  // the predicate entirely. Region strings are free-form and matched
  // case-sensitively against Node.region (also a free-form String?
  // column).
  const requiredRegion = (cr as { requiredRegion?: string | null }).requiredRegion
  const candidates = await prisma.node.findMany({
    where: {
      gpuTier: cr.gpuTier,
      status: 'ONLINE',
      currentJobId: null,
      assignedComputeRequestId: null,
      pendingDeletion: false,
      agentVersion: { not: null },
      lastHeartbeat: { gte: new Date(Date.now() - HEARTBEAT_FRESH_MS) },
      ...(requiredRegion ? { region: requiredRegion } : {}),
    },
    orderBy: { lastHeartbeat: 'desc' },
    take: PICK_POOL,
    select: {
      id: true,
      walletAddress: true,
      lastHeartbeat: true,
      nodeRunner: { select: { id: true, reputationTier: true, reputationScore: true } },
    },
  })

  // M3 sort: reputation desc (nulls last) -> heartbeat desc
  const idleNodes = candidates
    .sort((a, b) => {
      // -Infinity for null score so it always sorts AFTER any real score
      const aScore = a.nodeRunner?.reputationScore ?? -Infinity
      const bScore = b.nodeRunner?.reputationScore ?? -Infinity
      if (aScore !== bScore) return bScore - aScore
      return b.lastHeartbeat.getTime() - a.lastHeartbeat.getTime()
    })
    .slice(0, cr.gpuCount)

  if (idleNodes.length < cr.gpuCount) {
    // Insufficient supply — stay in PENDING, retry next tick. We don't
    // mark anything; the request stays exactly where it was. We do
    // record an eligibility flag so admin can see the request is paid
    // and waiting on capacity. M4.4: distinguish region-bound from
    // generic capacity shortage so admin's Needs Review queue can see
    // when a buyer asked for an unstocked region.
    const capacityFlag = requiredRegion ? 'NO_REGION_CAPACITY' : 'WAITING_ON_CAPACITY'
    await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        eligibilityFlags: [...verdict.flags, capacityFlag],
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
  // node (Node model doesn't carry sshHost/sshPort itself). For a
  // single-node rental we just need the head node's host; for a cluster
  // we also need every other node's host so the WireGuard mesh planner
  // can build per-node endpoint entries.
  const investments = await prisma.investment.findMany({
    where: { nodeId: { in: nodeIds } },
    select: { nodeId: true, sshHost: true, sshPort: true, sshUsername: true },
  })
  const investmentByNode = new Map(investments.map(i => [i.nodeId, i]))
  const headInvestment = investmentByNode.get(headNodeId)

  // M4.7: when gpuCount > 1 we build a real cluster: a Cluster row, a
  // WireGuard mesh plan, and per-node rank + IP assignments inside
  // the atomic transaction below. Single-GPU rentals skip this entirely.
  const isCluster = cr.gpuCount > 1
  const clusterMesh = isCluster
    ? planClusterMesh(
        // The mesh plan uses the ComputeRequest id as a stable seed.
        // The Cluster row gets its own cuid below.
        cr.id,
        nodeIds.map(id => {
          const inv = investmentByNode.get(id)
          return {
            nodeId: id,
            publicHost: inv?.sshHost ?? `node-${id.slice(0, 8)}.unknown`,
          }
        }),
      )
    : null

  // M2 self-serve: the allocator transitions PENDING straight to ACTIVE
  // (skipping ALLOCATED) because everything the buyer needs is in place
  // at this point — node assigned, ephemeral SSH minted, rate computed.
  // The Phase 1 admin "review SSH details and click Activate" step was
  // a holdover from the data-center provisioning model where a human
  // confirmed the rack was up. With seeded ephemeral credentials it's
  // dead weight and breaks the sub-15s pay-to-prompt promise.
  //
  // Manual admin allocate routes (Manual Allocate + Activate from the
  // dashboard) still set status=ALLOCATED -> ACTIVE in two steps, so
  // the legacy flow is preserved for cases where an operator wants to
  // intervene.
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  // Use a transaction so node assignment and request transition land
  // together. If the request status guard fails (someone else won the
  // race), the node update is rolled back too. M4.7: when gpuCount > 1
  // we also create a Cluster row and stamp each Node with its rank +
  // WireGuard IP in the same transaction so the whole allocation is
  // truly atomic - any failure rolls back the cluster, all node
  // assignments, and the request transition.
  const allocated = await prisma.$transaction(async tx => {
    // Cluster creation goes first so we can reference its id below.
    let clusterId: string | null = null
    if (isCluster && clusterMesh) {
      const cluster = await tx.cluster.create({
        data: {
          status: 'PROVISIONING',
          wireguardSubnet: clusterMesh.subnet,
          masterNodeId: headNodeId,
        },
      })
      clusterId = cluster.id
    }

    const updated = await tx.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        status: 'ACTIVE',
        approvedAt: cr.approvedAt ?? now,
        allocatedAt: now,
        activatedAt: now,
        expiresAt,
        allocatedNodeIds: nodeIds,
        allocationMethod: 'auto',
        eligibilityFlags: verdict.flags,
        ratePerMinute,
        sshSessionToken: session.token,
        sshSessionTokenExpiresAt: session.expiresAt,
        // SSH entrypoint: for a single-node rental this is the node's
        // public host. For a cluster, this is the master/head node's
        // host; workers are reached via ssh -J master worker-N over
        // the WireGuard mesh.
        sshHost: headInvestment?.sshHost ?? null,
        sshPort: headInvestment?.sshPort ?? 22,
        sshUsername: 'a2e-buyer',
        clusterId,
      },
    })
    if (updated.count === 0) {
      // Lost the race; abort the transaction so nodes (and any cluster
      // we just created) stay free.
      throw new Error('AllocationRaceLost')
    }

    if (isCluster && clusterMesh && clusterId) {
      // M4.7: per-node cluster stamps. We do this one node at a time
      // because each row gets a distinct rank + ip; updateMany can't
      // express that in one call.
      for (const cfg of clusterMesh.nodes) {
        const taken = await tx.node.updateMany({
          where: { id: cfg.nodeId, assignedComputeRequestId: null },
          data: {
            assignedComputeRequestId: cr.id,
            clusterId,
            clusterRank: cfg.rank,
            clusterWireguardIp: cfg.ip,
          },
        })
        if (taken.count === 0) {
          // Someone else won this specific node in a race. Abort the
          // whole transaction so the partial cluster doesn't leak.
          throw new Error('AllocationRaceLost')
        }
      }
    } else {
      await tx.node.updateMany({
        where: { id: { in: nodeIds }, assignedComputeRequestId: null },
        data: { assignedComputeRequestId: cr.id },
      })
    }
    return true
  }).catch((err: Error) => {
    if (err.message === 'AllocationRaceLost') return false
    throw err
  })

  if (!allocated) return

  // M2: rental is now ACTIVE — buyer can SSH in, meter starts ticking
  // on the next 60s tick. Notification reflects "live" not just "allocated".
  void createNotification(
    cr.userId,
    'COMPUTE_ACTIVE',
    'Compute is Live',
    `Your ${cr.gpuCount}x ${cr.gpuTier} compute is ready. SSH details are in your dashboard.`,
  )

  // Emit both events so existing dashboard subscribers (e.g. the toast for
  // 'compute:allocated' that already exists) keep working, and any new
  // subscribers can listen on the more accurate 'compute:active' name.
  const payload = {
    requestId: cr.id,
    userId: cr.userId,
    nodeIds,
    timestamp: now.toISOString(),
  }
  io.emit('compute:allocated', payload)
  io.emit('compute:active', payload)
}
