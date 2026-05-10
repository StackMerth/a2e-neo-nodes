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
  const result = await prisma.node.updateMany({
    where: { id: { startsWith: 'seed-node-' } },
    data: {
      status: 'ONLINE',
      lastHeartbeat: new Date(),
      missedBeats: 0,
      pendingDeletion: false,
    },
  })

  // One-line log per tick so the operator can confirm it's alive.
  // eslint-disable-next-line no-console
  console.log(`[seed-keep-alive] refreshed ${result.count} seed nodes`)
}
