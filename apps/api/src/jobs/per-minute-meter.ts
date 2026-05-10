/**
 * M2 / B3: per-minute billing meter.
 *
 * For every ACTIVE ComputeRequest, compute how many full minutes have
 * elapsed since activation, multiply by the per-rental ratePerMinute
 * (set by the allocator at allocation time), and write the pair onto
 * minutesUsed + accruedCost. The buyer dashboard ticker reads these
 * fields directly via WebSocket so the UI stays honest about cost in
 * near-real-time.
 *
 * Why recompute from scratch each tick instead of incrementing:
 *   - Idempotent: if the worker misses a tick (deploy, restart) the
 *     next tick catches up exactly. No drift.
 *   - Crash-safe: no risk of double-counting on retry.
 *   - Cheap: a single updateMany per row is one query + one log line.
 *
 * Tick interval: 60s. The meter is allowed to lag the wall clock by up
 * to 60s — the buyer's accruedCost catches up at the next tick. For
 * billing accuracy this is fine: the buyer is charged for elapsed
 * minutes, not "minutes since the last UI refresh."
 *
 * Edge cases handled:
 *   - ratePerMinute is null (legacy ACTIVE rentals from pre-M2): skipped.
 *     The settlement engine handles those on its own track.
 *   - Rental expired (now > expiresAt): meter clamps minutesUsed at the
 *     full duration and stops climbing. The completion worker (separate)
 *     will move it to COMPLETED.
 *   - activatedAt missing: skipped (data inconsistency, not the meter's
 *     job to repair).
 *
 * Per-tick websocket emit: a 'compute:tick' event lets the dashboard
 * show the live ticker without polling. Throttled implicitly to one
 * emit per request per 60s.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'

const QUEUE_NAME = 'per-minute-meter'
const TICK_INTERVAL_MS = parseInt(process.env.METER_TICK_MS ?? '60000', 10)
const BATCH_SIZE = 200

interface MeterDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createPerMinuteMeterQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createPerMinuteMeterWorker(deps: MeterDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runMeterTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function schedulePerMinuteMeter(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runMeterTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  const active = await prisma.computeRequest.findMany({
    where: {
      status: 'ACTIVE',
      ratePerMinute: { not: null },
      activatedAt: { not: null },
    },
    take: BATCH_SIZE,
    select: {
      id: true,
      userId: true,
      activatedAt: true,
      ratePerMinute: true,
      durationDays: true,
      totalCost: true,
      minutesUsed: true,
    },
  })

  const now = Date.now()

  for (const cr of active) {
    if (!cr.activatedAt || cr.ratePerMinute == null) continue

    const elapsedMs = now - cr.activatedAt.getTime()
    const elapsedMinutesFloat = elapsedMs / 60000
    const maxMinutes = cr.durationDays * 24 * 60
    const minutesUsed = Math.min(Math.floor(elapsedMinutesFloat), maxMinutes)

    if (minutesUsed === cr.minutesUsed) {
      // Nothing new to record. Don't even hit the DB or websocket.
      continue
    }

    const accruedCost = Math.min(
      Number((minutesUsed * cr.ratePerMinute).toFixed(4)),
      cr.totalCost,
    )

    await prisma.computeRequest.update({
      where: { id: cr.id },
      data: { minutesUsed, accruedCost },
    })

    io.emit('compute:tick', {
      requestId: cr.id,
      userId: cr.userId,
      minutesUsed,
      accruedCost,
      remainingCost: Number((cr.totalCost - accruedCost).toFixed(4)),
      timestamp: new Date().toISOString(),
    })
  }
}
