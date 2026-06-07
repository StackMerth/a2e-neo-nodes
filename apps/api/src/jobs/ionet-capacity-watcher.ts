/**
 * io.net capacity watcher.
 *
 * Mirror of lambda-capacity-watcher.ts for io.net. Polls io.net's
 * VMaaS hardware catalog on a slow cadence (default 5 min) and emails
 * the admin when any watched hardware_id has available supply. Useful
 * for tracking the high-end SKUs that flicker in and out of stock
 * (8x H100, B200, B300 servers; A100 multi-GPU SKUs).
 *
 * Configuration:
 *   IONET_CAPACITY_WATCH_SKUS
 *     Comma-separated list of io.net hardware_id strings. Example:
 *       '8H100.80S.176V,8B200.240V,8B300.240V'
 *     hardware_id must match io.net's exact catalog string (per
 *     scripts/ionet-inspect.ts output). When unset, the worker is a
 *     no-op.
 *   IONET_CAPACITY_WATCH_EMAIL
 *     Where to send alerts. Falls back to LAMBDA_CAPACITY_WATCH_EMAIL
 *     so admins don't have to set both for a shared inbox.
 *   IONET_CAPACITY_WATCH_TICK_MS
 *     Tick override; default 300_000 (5 min).
 *
 * Dedupe: Redis key `ionet-capacity:notified:<hardware_id>` with 1h
 * TTL. Same flicker-protection pattern as the other watchers.
 *
 * Admin-only by design.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import {
  IoNetClient,
  isIoNetConfigured,
  isIoNetAllocatorEnabled,
} from '../services/inbound/ionet-adapter.js'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'

const QUEUE_NAME = 'ionet-capacity-watcher'
const TICK_INTERVAL_MS = parseInt(process.env.IONET_CAPACITY_WATCH_TICK_MS ?? '300000', 10)
const DEDUPE_TTL_SECONDS = 3600

interface WatcherDeps {
  redis: ConnectionOptions
}

interface AvailableSku {
  hardwareId: string
  name: string
  numCards: number
  pricePerHourUsd: number
  supplier: string
}

export function createIoNetCapacityWatcherQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createIoNetCapacityWatcherWorker(deps: WatcherDeps): Worker {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  return new Worker(
    QUEUE_NAME,
    async () => {
      await runIoNetCapacityWatchTick(redis)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleIoNetCapacityWatcher(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runIoNetCapacityWatchTick(redis: Redis): Promise<{
  watchedSkus: string[]
  availableNow: AvailableSku[]
  alertedThisTick: string[]
  clearedThisTick: string[]
}> {
  const skusEnv = process.env.IONET_CAPACITY_WATCH_SKUS?.trim()
  if (!skusEnv) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }
  if (!isIoNetConfigured() || !isIoNetAllocatorEnabled()) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const watchedSkus = skusEnv.split(',').map((s) => s.trim()).filter(Boolean)
  if (watchedSkus.length === 0) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const client = new IoNetClient()
  let catalog
  try {
    catalog = await client.listHardware()
  } catch (err) {
    console.error(
      '[ionet-capacity-watcher] listHardware failed:',
      err instanceof Error ? err.message : err,
    )
    return { watchedSkus, availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const availableNow: AvailableSku[] = []
  const alertedThisTick: string[] = []
  const clearedThisTick: string[] = []

  for (const sku of watchedSkus) {
    const dedupeKey = `ionet-capacity:notified:${sku}`
    const hw = catalog.find((row) => row.deployId === sku || row.id === sku)

    // SKU not in current catalog -> treat as no capacity.
    if (!hw) {
      const deleted = await redis.del(dedupeKey)
      if (deleted > 0) clearedThisTick.push(sku)
      continue
    }

    availableNow.push({
      hardwareId: hw.deployId,
      name: hw.name,
      numCards: hw.numCards,
      pricePerHourUsd: hw.pricePerHourUsd,
      supplier: hw.supplier,
    })

    const wasNew = await redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
    if (wasNew === 'OK') {
      alertedThisTick.push(sku)
    }
  }

  if (alertedThisTick.length > 0) {
    await sendIoNetCapacityAlert(alertedThisTick, availableNow)
  }

  return { watchedSkus, availableNow, alertedThisTick, clearedThisTick }
}

async function sendIoNetCapacityAlert(
  newlyAvailable: string[],
  allAvailable: AvailableSku[],
): Promise<void> {
  if (!(await isEmailConfigured())) {
    console.log(
      `[ionet-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but email is not configured.`,
    )
    return
  }

  const recipient = (
    process.env.IONET_CAPACITY_WATCH_EMAIL?.trim()
    || process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim()
  )
  if (!recipient) {
    console.log(
      `[ionet-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but no recipient set.`,
    )
    return
  }

  const rows = newlyAvailable
    .map((sku) => {
      const row = allAvailable.find((r) => r.hardwareId === sku)
      if (!row) return ''
      return `
        <tr>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;font-family:monospace;">${row.hardwareId}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.name}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.numCards}x</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">$${row.pricePerHourUsd.toFixed(2)}/h</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.supplier}</td>
        </tr>`
    })
    .filter(Boolean)
    .join('')

  const html = `
    <p>io.net capacity opened for one or more SKUs you are watching:</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <thead>
        <tr style="background:#f6f6f6;">
          <th style="padding:8px 16px;text-align:left;">hardware_id</th>
          <th style="padding:8px 16px;text-align:left;">Name</th>
          <th style="padding:8px 16px;text-align:left;">GPUs</th>
          <th style="padding:8px 16px;text-align:left;">Price</th>
          <th style="padding:8px 16px;text-align:left;">Supplier</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p>io.net catalog churns; SKU rotation observed in 30-minute windows. Re-alerts suppressed for 1h per hardware_id.</p>
  `.trim()

  await sendEmail(
    recipient,
    `[TokenOS] io.net capacity opened: ${newlyAvailable.join(', ')}`,
    html,
  )
}
