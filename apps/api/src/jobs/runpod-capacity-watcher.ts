/**
 * T5e — RunPod capacity watcher (mirror of T5d Lambda watcher).
 *
 * Polls RunPod's GraphQL gpuTypes catalog on a slow cadence (default
 * 5 min) and emails the platform admin when any of the watched gpu
 * type IDs has stock in EITHER community OR secure tier. Built so we
 * get pinged the moment 8x H100 / B200 supply opens on RunPod even
 * when Lambda is dry.
 *
 * Configuration (env-driven, no DB tables — same as T5d):
 *   RUNPOD_CAPACITY_WATCH_IDS
 *     Comma-separated RunPod gpu type IDs to watch. These are the
 *     canonical 'NVIDIA <displayName>' strings (NOT the displayName).
 *     Example:
 *       RUNPOD_CAPACITY_WATCH_IDS=NVIDIA H100 80GB HBM3,NVIDIA H200 NVL,NVIDIA B200
 *   RUNPOD_CAPACITY_WATCH_EMAIL
 *     Recipient. Defaults to LAMBDA_CAPACITY_WATCH_EMAIL when unset so
 *     you only configure one address for both watchers.
 *   RUNPOD_CAPACITY_WATCH_TICK_MS
 *     Override tick interval. Default 300_000 (5 min).
 *
 * Dedupe contract (identical to T5d):
 *   - Redis SET with 1h TTL: runpod-capacity:notified:<id>
 *   - Set when we send an alert; auto-expires after 1h
 *   - Cleared when the SKU goes back to no-stock so the next opening
 *     re-fires a fresh alert
 *
 * Stock signal: GraphQL returns a SKU with non-null prices when any
 * tier has stock. We treat "has either secure or community price" as
 * "currently available somewhere." Per-tier granularity isn't worth
 * the complexity at MVP.
 *
 * Admin-only by design (see [[capacity_alerts_admin_only]] memory)
 * — no buyer notifications. When a tester asks about 8x H100, the
 * admin checks email + relays. Buyer-facing subscribe-me UI is a
 * later milestone when there are 100+ buyers.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { RunPodClient, isRunPodConfigured } from '../services/inbound/runpod-adapter.js'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'

const QUEUE_NAME = 'runpod-capacity-watcher'
const TICK_INTERVAL_MS = parseInt(process.env.RUNPOD_CAPACITY_WATCH_TICK_MS ?? '300000', 10)
const DEDUPE_TTL_SECONDS = 3600

interface WatcherDeps {
  redis: ConnectionOptions
}

export function createRunPodCapacityWatcherQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createRunPodCapacityWatcherWorker(deps: WatcherDeps): Worker {
  // Dedicated Redis client for dedupe SET/GET. Reuses the plugin's
  // REDIS_URL so it picks up Render's a2e-redis connection string.
  // The old `new Redis(deps.redis as never)` passed the existing
  // ioredis instance as the constructor arg — ioredis can't parse a
  // Redis object as a URL/options and silently fell back to
  // localhost:6379, producing the ECONNREFUSED log spam on every
  // tick. Fixed by reading the URL directly the same way the plugin
  // does.
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runRunPodCapacityWatchTick(redis)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleRunPodCapacityWatcher(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick
// ---------------------------------------------------------------------------

interface AvailableSku {
  id: string
  displayName: string
  lowestPricePerHourUsd: number | null
  securePricePerHourUsd: number | null
  communityPricePerHourUsd: number | null
}

export async function runRunPodCapacityWatchTick(redis: Redis): Promise<{
  watchedIds: string[]
  availableNow: AvailableSku[]
  alertedThisTick: string[]
  clearedThisTick: string[]
}> {
  const idsEnv = process.env.RUNPOD_CAPACITY_WATCH_IDS?.trim()
  if (!idsEnv) {
    return { watchedIds: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }
  if (!isRunPodConfigured()) {
    return { watchedIds: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const watchedIds = idsEnv.split(',').map((s) => s.trim()).filter(Boolean)
  if (watchedIds.length === 0) {
    return { watchedIds: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const client = new RunPodClient()
  const types = await client.listGpuTypes()

  const availableNow: AvailableSku[] = []
  const alertedThisTick: string[] = []
  const clearedThisTick: string[] = []

  for (const id of watchedIds) {
    const t = types.find((row) => row.id === id)
    const dedupeKey = `runpod-capacity:notified:${id}`

    if (!t || !t.hasCurrentStock) {
      const deleted = await redis.del(dedupeKey)
      if (deleted > 0) clearedThisTick.push(id)
      continue
    }

    availableNow.push({
      id: t.id,
      displayName: t.displayName,
      lowestPricePerHourUsd: t.lowestPricePerHourUsd,
      securePricePerHourUsd: t.securePricePerHourUsd,
      communityPricePerHourUsd: t.communityPricePerHourUsd,
    })

    const wasNew = await redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
    if (wasNew === 'OK') {
      alertedThisTick.push(id)
    }
  }

  if (alertedThisTick.length > 0) {
    await sendCapacityAlertEmail(alertedThisTick, availableNow)
  }

  return { watchedIds, availableNow, alertedThisTick, clearedThisTick }
}

async function sendCapacityAlertEmail(
  newlyAvailable: string[],
  allAvailable: AvailableSku[],
): Promise<void> {
  if (!(await isEmailConfigured())) {
    // eslint-disable-next-line no-console
    console.log(`[runpod-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but email is not configured.`)
    return
  }

  // Default to the Lambda watcher's recipient when the RunPod-specific
  // env var isn't set, so only one address is needed for both.
  const recipient = (
    process.env.RUNPOD_CAPACITY_WATCH_EMAIL?.trim() ||
    process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim() ||
    ''
  )
  if (!recipient) {
    // eslint-disable-next-line no-console
    console.log(`[runpod-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but neither RUNPOD_CAPACITY_WATCH_EMAIL nor LAMBDA_CAPACITY_WATCH_EMAIL is set.`)
    return
  }

  const rows = newlyAvailable
    .map((id) => {
      const row = allAvailable.find((r) => r.id === id)
      if (!row) return ''
      const secure = row.securePricePerHourUsd !== null ? `$${row.securePricePerHourUsd.toFixed(2)}/h` : '-'
      const community = row.communityPricePerHourUsd !== null ? `$${row.communityPricePerHourUsd.toFixed(2)}/h` : '-'
      return `
        <tr>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;font-family:monospace;">${row.id}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.displayName}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${secure}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${community}</td>
        </tr>`
    })
    .filter(Boolean)
    .join('')

  const html = `
    <p>RunPod capacity opened for one or more SKUs you are watching:</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <thead>
        <tr style="background:#f6f6f6;">
          <th style="padding:8px 16px;text-align:left;">id</th>
          <th style="padding:8px 16px;text-align:left;">display</th>
          <th style="padding:8px 16px;text-align:left;">secure</th>
          <th style="padding:8px 16px;text-align:left;">community</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p>RunPod capacity windows close fast &mdash; ping your tester now if they want one of these.</p>
    <p style="color:#666;font-size:12px;">
      You will not be re-alerted for the same SKU within the next hour (TTL), unless its capacity goes away and then re-opens.
    </p>
  `.trim()

  await sendEmail(
    recipient,
    `[TokenOS] RunPod capacity opened: ${newlyAvailable.length} SKU(s)`,
    html,
  )
}
