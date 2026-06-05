/**
 * T5d — Lambda capacity watcher.
 *
 * Polls Lambda's instance-types catalog on a slow cadence (default
 * 5 min) and emails the platform admin when any of the configured
 * "watched" SKUs has capacity in any region. Originally built to
 * unblock early testers asking for 8x H100 or 4x B200 boxes that
 * Lambda routinely shows "no capacity right now" for — the watcher
 * fires the moment supply opens so you can ping the tester before
 * Lambda's churn closes the window again.
 *
 * Configuration (all env-driven, no DB tables):
 *   LAMBDA_CAPACITY_WATCH_SKUS
 *     Comma-separated Lambda instance type names to watch. Example:
 *       gpu_8x_h100_sxm5,gpu_8x_b200_sxm6,gpu_4x_h100_sxm5,gpu_4x_b200_sxm6
 *     When unset, the worker tick is a no-op so production deploys
 *     without this flag get zero behavior change.
 *   LAMBDA_CAPACITY_WATCH_EMAIL
 *     Where to send the alert email. Defaults to the user account
 *     associated with admin@tokenos.ai if unset.
 *   LAMBDA_CAPACITY_WATCH_TICK_MS
 *     Override tick interval in ms. Default 300_000 (5 min).
 *
 * Dedupe contract (avoids alert spam):
 *   - Redis SET key `lambda-capacity:notified:<sku>` with 1h TTL is
 *     written when we send an alert. While the key exists, we won't
 *     fire again for the same SKU.
 *   - When a watched SKU goes BACK to no-capacity, we delete the key
 *     so the next opening re-fires a fresh alert. This means a SKU
 *     that flickers in and out fires at most every hour (TTL), and a
 *     SKU that opens cleanly fires once.
 *   - The "watch is hot" state is implicit — no per-SKU subscriber
 *     management. If admin doesn't want alerts anymore, just unset
 *     LAMBDA_CAPACITY_WATCH_SKUS.
 *
 * No buyer-facing notification — this is admin-only by design.
 * Operator-side capacity opportunity awareness would be its own
 * feature with subscribe / unsubscribe UX.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { LambdaClient, isLambdaConfigured } from '../services/inbound/lambda-adapter.js'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'

const QUEUE_NAME = 'lambda-capacity-watcher'
const TICK_INTERVAL_MS = parseInt(process.env.LAMBDA_CAPACITY_WATCH_TICK_MS ?? '300000', 10)
// Dedupe key TTL — long enough that a SKU bouncing in/out of capacity
// every few minutes doesn't spam, short enough that you get re-alerted
// when capacity opens after a long quiet period.
const DEDUPE_TTL_SECONDS = 3600

interface WatcherDeps {
  redis: ConnectionOptions
}

export function createLambdaCapacityWatcherQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createLambdaCapacityWatcherWorker(deps: WatcherDeps): Worker {
  // Dedicated Redis client for dedupe SET/GET. Reuses REDIS_URL the
  // same way the redis plugin does. The old `new Redis(deps.redis as
  // never)` passed the existing ioredis instance as constructor arg
  // — ioredis can't parse a Redis object and silently fell back to
  // localhost:6379, producing the ECONNREFUSED log spam every tick.
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  return new Worker(
    QUEUE_NAME,
    async () => {
      await runCapacityWatchTick(redis)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleLambdaCapacityWatcher(queue: Queue): Promise<void> {
  // Wipe any previous repeatable jobs to avoid duplicates on redeploy.
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
  name: string
  pricePerHourUsd: number
  regionsAvailable: string[]
}

/**
 * Single watcher tick. Returns a structured summary so tests and the
 * inspector script can call this directly without going through the
 * BullMQ infrastructure.
 */
export async function runCapacityWatchTick(redis: Redis): Promise<{
  watchedSkus: string[]
  availableNow: AvailableSku[]
  alertedThisTick: string[]
  clearedThisTick: string[]
}> {
  const skusEnv = process.env.LAMBDA_CAPACITY_WATCH_SKUS?.trim()
  if (!skusEnv) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }
  if (!isLambdaConfigured()) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const watchedSkus = skusEnv.split(',').map((s) => s.trim()).filter(Boolean)
  if (watchedSkus.length === 0) {
    return { watchedSkus: [], availableNow: [], alertedThisTick: [], clearedThisTick: [] }
  }

  const client = new LambdaClient()
  const types = await client.listInstanceTypes()

  const availableNow: AvailableSku[] = []
  const alertedThisTick: string[] = []
  const clearedThisTick: string[] = []

  for (const sku of watchedSkus) {
    const t = types.find((row) => row.name === sku)
    const dedupeKey = `lambda-capacity:notified:${sku}`

    // SKU isn't in Lambda's catalog at all → treat as no capacity.
    // Clears the dedupe key so a future re-listing re-arms the alert.
    if (!t || t.regionsAvailable.length === 0) {
      const deleted = await redis.del(dedupeKey)
      if (deleted > 0) clearedThisTick.push(sku)
      continue
    }

    availableNow.push({
      name: t.name,
      pricePerHourUsd: t.pricePerHourUsd,
      regionsAvailable: t.regionsAvailable,
    })

    // Only alert if we haven't already alerted within the TTL window.
    // setnx + expire pattern avoids a TOCTOU between get and set.
    const wasNew = await redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
    if (wasNew === 'OK') {
      alertedThisTick.push(sku)
    }
  }

  if (alertedThisTick.length > 0) {
    await sendCapacityAlertEmail(alertedThisTick, availableNow)
  }

  return { watchedSkus, availableNow, alertedThisTick, clearedThisTick }
}

async function sendCapacityAlertEmail(
  newlyAvailable: string[],
  allAvailable: AvailableSku[],
): Promise<void> {
  if (!(await isEmailConfigured())) {
    // eslint-disable-next-line no-console
    console.log(`[lambda-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but email is not configured. Set SMTP env vars (and LAMBDA_CAPACITY_WATCH_EMAIL) to receive alerts.`)
    return
  }

  const recipient = process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim()
  if (!recipient) {
    // eslint-disable-next-line no-console
    console.log(`[lambda-capacity-watcher] capacity opened for ${newlyAvailable.join(', ')} but LAMBDA_CAPACITY_WATCH_EMAIL is unset.`)
    return
  }

  // Compact email body — point of this alert is "act now", not deep
  // analytics. Include price + regions per newly-open SKU so the
  // operator can immediately ping the tester with a recommendation.
  const rows = newlyAvailable
    .map((sku) => {
      const row = allAvailable.find((r) => r.name === sku)
      if (!row) return ''
      return `
        <tr>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;font-family:monospace;">${row.name}</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">$${row.pricePerHourUsd.toFixed(2)}/h</td>
          <td style="padding:8px 16px;border-bottom:1px solid #eee;">${row.regionsAvailable.join(', ')}</td>
        </tr>`
    })
    .filter(Boolean)
    .join('')

  const html = `
    <p>Lambda capacity opened for one or more SKUs you are watching:</p>
    <table style="border-collapse:collapse;margin:16px 0;">
      <thead>
        <tr style="background:#f6f6f6;">
          <th style="padding:8px 16px;text-align:left;">SKU</th>
          <th style="padding:8px 16px;text-align:left;">Price</th>
          <th style="padding:8px 16px;text-align:left;">Regions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p>Lambda capacity windows close fast &mdash; ping your tester now if they still want one of these.</p>
    <p style="color:#666;font-size:12px;">
      You will not be re-alerted for the same SKU within the next hour (TTL), unless its capacity goes away and then re-opens.
    </p>
  `.trim()

  await sendEmail(
    recipient,
    `[TokenOS] Lambda capacity opened: ${newlyAvailable.join(', ')}`,
    html,
  )
}
