/**
 * Vast.ai capacity watcher.
 *
 * Mirror of lambda-capacity-watcher.ts for Vast.ai. Polls Vast.ai's
 * /bundles/ endpoint on a slow cadence (default 5 min) and emails the
 * admin when any watched (gpu_name, num_gpus) SKU has verified+reliable
 * supply. Useful for admin-side awareness when a thinly-supplied SKU
 * suddenly opens up (e.g. H100 NVL 1x typically has 2-4 verified
 * hosts, periodically dipping to zero).
 *
 * Configuration:
 *   VASTAI_CAPACITY_WATCH_SKUS
 *     Comma-separated list of "<gpu_name>|<num_gpus>" pairs.
 *     Example: 'H100 NVL|1,H100 SXM|8,H200 NVL|1,B200|1'
 *     gpu_name must match Vast.ai's exact catalog string (per
 *     inspect-vastai-datacenter-skus output). num_gpus is an integer.
 *     When unset, the worker is a no-op.
 *   VASTAI_CAPACITY_WATCH_EMAIL
 *     Where to send alerts. Falls back to LAMBDA_CAPACITY_WATCH_EMAIL
 *     so admins don't have to set both for shared inboxes.
 *   VASTAI_CAPACITY_WATCH_TICK_MS
 *     Tick override; default 300_000 (5 min). Stays well under
 *     Vast.ai's 5-req/10s rate limit even with many watched SKUs.
 *
 * Dedupe: Redis key `vastai-capacity:notified:<gpu_name>|<num_gpus>`
 * with 1h TTL. Same flicker-protection pattern as the Lambda watcher.
 *
 * Admin-only by design; no buyer-facing subscription UX in this pass.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import {
  VastAiClient,
  isVastAiConfigured,
  isVastAiAllocatorEnabled,
  isVastAiHostExcluded,
} from '../services/inbound/vastai-adapter.js'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'

const QUEUE_NAME = 'vastai-capacity-watcher'
const TICK_INTERVAL_MS = parseInt(process.env.VASTAI_CAPACITY_WATCH_TICK_MS ?? '300000', 10)
const DEDUPE_TTL_SECONDS = 3600
// Minimum reliability to count as "available". Matches the cascade
// probe's threshold so the alert reflects what an actual rental
// request would see.
const MIN_RELIABILITY = 0.85

interface WatcherDeps {
  redis: ConnectionOptions
}

interface WatchedSku {
  gpuName: string
  numGpus: number
  /** Key used in dedupe + alert table. */
  display: string
}

interface AvailableSku {
  display: string
  cheapestPricePerHourUsd: number
  verifiedHostCount: number
  topRegions: string[]
}

export function createVastAiCapacityWatcherQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createVastAiCapacityWatcherWorker(deps: WatcherDeps): Worker {
  // Separate Redis client for dedupe SET/GET (same pattern as Lambda
  // watcher; avoids the silent-fallback-to-localhost bug from passing
  // an ioredis instance as a constructor arg).
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  return new Worker(
    QUEUE_NAME,
    async () => {
      await runVastAiCapacityWatchTick(redis)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleVastAiCapacityWatcher(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

function parseWatchedSkus(): WatchedSku[] {
  const raw = process.env.VASTAI_CAPACITY_WATCH_SKUS?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const [gpuName, numStr] = spec.split('|').map((p) => p.trim())
      const numGpus = parseInt(numStr ?? '', 10)
      if (!gpuName || !Number.isFinite(numGpus) || numGpus <= 0) {
        console.warn(
          `[vastai-capacity-watcher] ignoring malformed VASTAI_CAPACITY_WATCH_SKUS entry: '${spec}' (expected '<gpu_name>|<num_gpus>')`,
        )
        return null
      }
      return { gpuName, numGpus, display: `${gpuName} (${numGpus}x)` } as WatchedSku
    })
    .filter((s): s is WatchedSku => s !== null)
}

export async function runVastAiCapacityWatchTick(redis: Redis): Promise<{
  watchedSkus: WatchedSku[]
  availableNow: AvailableSku[]
  alertedThisTick: string[]
  clearedThisTick: string[]
}> {
  const watchedSkus = parseWatchedSkus()
  if (watchedSkus.length === 0) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }
  // Gate on both configured AND allocator-enabled: if Vast.ai is
  // disabled in the cascade, watching its capacity provides admin
  // info but no rentals would route to it anyway.
  if (!isVastAiConfigured() || !isVastAiAllocatorEnabled()) {
    return { watchedSkus, availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const client = new VastAiClient()
  const availableNow: AvailableSku[] = []
  const alertedThisTick: string[] = []
  const clearedThisTick: string[] = []

  for (const sku of watchedSkus) {
    const dedupeKey = `vastai-capacity:notified:${sku.display}`
    let offers
    try {
      offers = await client.listOffers({
        gpu_name: { eq: sku.gpuName },
        num_gpus: { eq: sku.numGpus },
        reliability2: { gte: MIN_RELIABILITY },
      })
    } catch (err) {
      console.error(
        `[vastai-capacity-watcher] listOffers failed for ${sku.display}:`,
        err instanceof Error ? err.message : err,
      )
      continue
    }

    // Apply the same geo filter the cascade probe applies. An offer
    // in CN that we'd never book shouldn't count toward "capacity".
    const usable = offers.filter((o) => !isVastAiHostExcluded(o.geolocation))

    if (usable.length === 0) {
      const deleted = await redis.del(dedupeKey)
      if (deleted > 0) clearedThisTick.push(sku.display)
      continue
    }

    const cheapest = usable[0]?.dphTotal ?? 0
    const regions = Array.from(
      new Set(usable.map((o) => o.geolocation ?? 'unknown').filter(Boolean)),
    ).slice(0, 5)

    availableNow.push({
      display: sku.display,
      cheapestPricePerHourUsd: cheapest,
      verifiedHostCount: usable.length,
      topRegions: regions,
    })

    const wasNew = await redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
    if (wasNew === 'OK') {
      alertedThisTick.push(sku.display)
    }
  }

  if (alertedThisTick.length > 0) {
    await sendVastAiCapacityAlert(alertedThisTick, availableNow)
  }

  return { watchedSkus, availableNow, alertedThisTick, clearedThisTick }
}

async function sendVastAiCapacityAlert(
  newlyAvailable: string[],
  allAvailable: AvailableSku[],
): Promise<void> {
  if (!(await isEmailConfigured())) {
    console.log(
      `[vastai-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but email is not configured.`,
    )
    return
  }

  const recipient = (
    process.env.VASTAI_CAPACITY_WATCH_EMAIL?.trim()
    || process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim()
  )
  if (!recipient) {
    console.log(
      `[vastai-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but no recipient set (VASTAI_CAPACITY_WATCH_EMAIL / LAMBDA_CAPACITY_WATCH_EMAIL).`,
    )
    return
  }

  const rows = newlyAvailable
    .map((display) => {
      const row = allAvailable.find((r) => r.display === display)
      if (!row) return ''
      return `
        <tr>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;font-family:monospace;">${row.display}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">$${row.cheapestPricePerHourUsd.toFixed(2)}/h</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.verifiedHostCount} verified host(s)</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.topRegions.join(', ')}</td>
        </tr>`
    })
    .filter(Boolean)
    .join('')

  const html = `
    <p>Vast.ai capacity opened for one or more SKUs you are watching:</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <thead>
        <tr style="background:#f6f6f6;">
          <th style="padding:8px 16px;text-align:left;">SKU</th>
          <th style="padding:8px 16px;text-align:left;">Cheapest</th>
          <th style="padding:8px 16px;text-align:left;">Pool size</th>
          <th style="padding:8px 16px;text-align:left;">Regions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p>Peer-marketplace capacity churns fast. Re-alerts suppressed for 1h per SKU; cleared when the SKU goes back to zero.</p>
  `.trim()

  await sendEmail(
    recipient,
    `[TokenOS] Vast.ai capacity opened: ${newlyAvailable.join(', ')}`,
    html,
  )
}
