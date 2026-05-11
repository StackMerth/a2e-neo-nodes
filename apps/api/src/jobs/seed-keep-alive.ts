/**
 * Seed-node keep-alive (test-only).
 *
 * Bumps every `seed-node-*` row to `status=ONLINE` with a fresh
 * `lastHeartbeat` every 30 seconds. Replaces the need to leave a
 * Render web shell tab open running `seed-test-data.ts --keep-alive-only`
 * — this version lives inside the API process, so it survives shell
 * disconnects, browser closes, and even a deploy.
 *
 * SAFETY: only registered when SEED_KEEP_ALIVE_ENABLED=1. In normal
 * production this worker is dormant and the live node-agent heartbeats
 * are the only source of `lastHeartbeat` truth. Flip the env back to
 * unset (or "0") and redeploy to disable.
 *
 * Touches the Node table only:
 *   - id LIKE 'seed-node-%'
 *   - sets status='ONLINE', lastHeartbeat=NOW(), missedBeats=0,
 *     pendingDeletion=false
 *
 * Does NOT touch:
 *   - Heartbeat history rows (no need — Node.lastHeartbeat is what the
 *     allocator's idle query reads)
 *   - currentJobId / assignedComputeRequestId (preserves any in-flight
 *     allocations)
 *   - Any non-seed Node row
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const QUEUE_NAME = 'seed-keep-alive'
const TICK_INTERVAL_MS = parseInt(process.env.SEED_KEEP_ALIVE_TICK_MS ?? '30000', 10)

export function isSeedKeepAliveEnabled(): boolean {
  return process.env.SEED_KEEP_ALIVE_ENABLED === '1'
}

interface SeedKeepAliveDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createSeedKeepAliveQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    },
  })
}

export function createSeedKeepAliveWorker(deps: SeedKeepAliveDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runSeedKeepAliveTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleSeedKeepAlive(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runSeedKeepAliveTick(prisma: PrismaClient): Promise<void> {
  // Step 1: refresh status + heartbeat on every seed node, BUT respect
  // manual PAUSED state. The previous version set status='ONLINE'
  // unconditionally — which fought any operator who paused nodes via
  // SQL (e.g. to force demand-pressure scenarios for SPOT preemption
  // testing). Now we only flip OFFLINE/DEGRADED back to ONLINE; PAUSED
  // and MAINTENANCE stick until manually changed.
  const refreshResult = await prisma.node.updateMany({
    where: {
      id: { startsWith: 'seed-node-' },
      status: { in: ['ONLINE', 'OFFLINE', 'DEGRADED'] },
    },
    data: {
      status: 'ONLINE',
      lastHeartbeat: new Date(),
      missedBeats: 0,
      pendingDeletion: false,
    },
  })

  // Still bump heartbeat on PAUSED/MAINTENANCE nodes so they don't
  // appear "stale" to admin views — but their status is preserved.
  await prisma.node.updateMany({
    where: {
      id: { startsWith: 'seed-node-' },
      status: { in: ['PAUSED', 'MAINTENANCE'] },
    },
    data: {
      lastHeartbeat: new Date(),
      missedBeats: 0,
    },
  })

  // Step 2: clear orphaned assignments so seed nodes stay available
  // for testing. An orphan = a seed node assigned to a ComputeRequest
  // that is no longer ACTIVE (terminated, expired, completed, etc.).
  // Without this sweep, terminated rentals leave dangling
  // assignedComputeRequestId values that block the allocator from
  // re-using the node. Real production agents do this cleanup as part
  // of their own state machine; the keep-alive worker substitutes
  // for that during seed/test mode.
  //
  // Done as a 2-step (find + clear) instead of one update to log how
  // many orphans were cleared per tick — useful signal during testing.
  const allSeedNodes = await prisma.node.findMany({
    where: {
      id: { startsWith: 'seed-node-' },
      assignedComputeRequestId: { not: null },
    },
    select: { id: true, assignedComputeRequestId: true },
  })

  const orphanIds: string[] = []
  if (allSeedNodes.length > 0) {
    // Look up which compute requests are still ACTIVE
    const assignedCrIds = allSeedNodes
      .map(n => n.assignedComputeRequestId)
      .filter((id): id is string => id !== null)
    const activeCrs = await prisma.computeRequest.findMany({
      where: { id: { in: assignedCrIds }, status: 'ACTIVE' },
      select: { id: true },
    })
    const activeCrSet = new Set(activeCrs.map(cr => cr.id))

    for (const node of allSeedNodes) {
      if (node.assignedComputeRequestId && !activeCrSet.has(node.assignedComputeRequestId)) {
        orphanIds.push(node.id)
      }
    }

    if (orphanIds.length > 0) {
      await prisma.node.updateMany({
        where: { id: { in: orphanIds } },
        data: { assignedComputeRequestId: null },
      })
    }
  }

  // One-line log per tick so the operator can confirm it's alive.
  // eslint-disable-next-line no-console
  console.log(
    `[seed-keep-alive] refreshed ${refreshResult.count} seed nodes` +
      (orphanIds.length > 0 ? `, freed ${orphanIds.length} orphan assignments` : ''),
  )
}
