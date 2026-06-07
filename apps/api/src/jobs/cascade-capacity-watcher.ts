/**
 * Cascade-wide capacity transition watcher.
 *
 * One env var, every provider, every tier, every count: when ANY cell
 * in the (provider, tier, count) matrix transitions from no-capacity
 * to has-capacity, this watcher emails the admin within ~5 minutes.
 *
 * Why this exists alongside the per-provider watchers (lambda-,
 * runpod-, ionet-, vastai-capacity-watcher):
 *
 *   - Per-provider watchers need explicit SKU strings in env. Adding
 *     a new GPU tier or a new provider means editing
 *     IONET_CAPACITY_WATCH_SKUS, VASTAI_CAPACITY_WATCH_SKUS, etc., one
 *     by one. The provider-specific SKU naming (8H100.80S.176V vs
 *     H100 NVL|1 vs gpu_8x_h100_sxm5) can't be unified.
 *
 *   - This watcher reuses the SAME matrix the cascade-capacity-snapshot
 *     digest uses (probeAllProvidersDebug, every tier × every count).
 *     Plug a new provider into PROVIDER_ORDER and capacity-probe.ts and
 *     it's automatically watched here. No env edits needed.
 *
 * Per-provider watchers stay valuable for SURGICAL SKU watches that
 * aren't in the default matrix (e.g. a specific oversubscribed
 * 8B300.240V config you're hunting). The cascade watcher covers the
 * common case "alert me when anything opens anywhere."
 *
 * Configuration (one master + sane defaults):
 *   CASCADE_WATCH_ENABLED      Default 'true'. Set 'false' to no-op
 *                              the entire watcher (kill switch).
 *   CAPACITY_WATCH_EMAIL       Recipient (shared with all watchers).
 *                              Falls back to LAMBDA_CAPACITY_WATCH_EMAIL
 *                              so existing deploys keep working.
 *   CASCADE_WATCH_TICK_MS      Default 300_000 (5 min). Same cadence
 *                              as the per-provider watchers.
 *   CASCADE_WATCH_TIERS        Optional comma-separated GpuTier list.
 *                              Default: all tiers in DEFAULT_TIERS.
 *   CASCADE_WATCH_COUNTS       Optional comma-separated counts.
 *                              Default: 1,8 (the headline configs).
 *
 * Dedupe: Redis key `cascade-capacity:notified:<provider>:<tier>:<count>`
 * with 1h TTL. Mirror of the per-provider watchers' dedupe contract:
 *   - Set on alert send -> won't refire for the same cell while key
 *     lives.
 *   - Deleted when the cell goes back to no-capacity -> next opening
 *     refires a fresh alert.
 *
 * Admin-only by design (no buyer-facing capacity subscribe UX yet —
 * memory: [[capacity_alerts_admin_only]]).
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import type { GpuTier } from '@a2e/database'
import {
  probeAllProvidersDebug,
  type CapacityQuote,
  type ProviderKey,
} from '../services/inbound/capacity-probe.js'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'
import { resolveCapacityWatchRecipient } from '../services/email/capacity-recipient.js'

const QUEUE_NAME = 'cascade-capacity-watcher'
const TICK_INTERVAL_MS = parseInt(
  process.env.CASCADE_WATCH_TICK_MS ?? '300000',
  10,
)
const DEDUPE_TTL_SECONDS = 3600

const DEFAULT_TIERS: GpuTier[] = [
  'H100',
  'H200',
  'A100',
  'L40S',
  'B200',
  'B300',
  'GB300',
  'RTX_4090',
  'RTX_3090',
]
const DEFAULT_COUNTS = [1, 8]

interface WatcherDeps {
  redis: ConnectionOptions
}

interface CellKey {
  provider: ProviderKey
  tier: GpuTier
  count: number
}

interface AlertedCell extends CellKey {
  pricePerHourUsd: number
}

function dedupeKey(c: CellKey): string {
  return `cascade-capacity:notified:${c.provider}:${c.tier}:${c.count}`
}

function isEnabled(): boolean {
  return process.env.CASCADE_WATCH_ENABLED?.toLowerCase() !== 'false'
}

export function createCascadeCapacityWatcherQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createCascadeCapacityWatcherWorker(deps: WatcherDeps): Worker {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  return new Worker(
    QUEUE_NAME,
    async () => {
      await runCascadeCapacityWatchTick(redis)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleCascadeCapacityWatcher(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

function parseTiers(): GpuTier[] {
  const raw = process.env.CASCADE_WATCH_TIERS?.trim()
  if (!raw) return DEFAULT_TIERS
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase() as GpuTier)
    .filter(Boolean)
}

function parseCounts(): number[] {
  const raw = process.env.CASCADE_WATCH_COUNTS?.trim()
  if (!raw) return DEFAULT_COUNTS
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

export async function runCascadeCapacityWatchTick(redis: Redis): Promise<{
  alerted: AlertedCell[]
  cleared: CellKey[]
}> {
  if (!isEnabled()) {
    return { alerted: [], cleared: [] }
  }

  const tiers = parseTiers()
  const counts = parseCounts()
  const alerted: AlertedCell[] = []
  const cleared: CellKey[] = []

  for (const tier of tiers) {
    for (const count of counts) {
      let quotes: CapacityQuote[]
      try {
        quotes = await probeAllProvidersDebug(tier, count, {
          preferConfidential: false,
        })
      } catch (err) {
        console.error(
          `[cascade-capacity-watcher] probe failed for ${tier} x${count}:`,
          err instanceof Error ? err.message : err,
        )
        continue
      }

      for (const q of quotes) {
        const key: CellKey = { provider: q.provider, tier, count }
        const k = dedupeKey(key)

        if (q.hasCapacity) {
          const wasNew = await redis.set(k, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
          if (wasNew === 'OK') {
            alerted.push({ ...key, pricePerHourUsd: q.pricePerHourUsd })
          }
        } else {
          const deleted = await redis.del(k)
          if (deleted > 0) cleared.push(key)
        }
      }
    }
  }

  if (alerted.length > 0) {
    await sendTransitionAlert(alerted)
  }

  return { alerted, cleared }
}

async function sendTransitionAlert(cells: AlertedCell[]): Promise<void> {
  if (!(await isEmailConfigured())) {
    console.log(
      `[cascade-capacity-watcher] ${cells.length} cells opened but email is not configured.`,
    )
    return
  }

  const recipient = resolveCapacityWatchRecipient()
  if (!recipient) {
    console.log(
      `[cascade-capacity-watcher] ${cells.length} cells opened but no recipient set (CAPACITY_WATCH_EMAIL).`,
    )
    return
  }

  // Group rows by provider so the email reads provider-by-provider.
  const byProvider = new Map<ProviderKey, AlertedCell[]>()
  for (const c of cells) {
    const list = byProvider.get(c.provider) ?? []
    list.push(c)
    byProvider.set(c.provider, list)
  }

  const sections = Array.from(byProvider.entries())
    .map(([provider, rows]) => {
      const rowsHtml = rows
        .sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)
        .map(
          (r) => `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;">${r.tier}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;">${r.count}x</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;">$${r.pricePerHourUsd.toFixed(2)}/h</td>
        </tr>`,
        )
        .join('')
      return `
        <h3 style="margin:16px 0 8px;font-family:sans-serif;font-size:14px;">${provider}</h3>
        <table style="border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f6f6f6;">
            <th style="padding:6px 12px;text-align:left;">Tier</th>
            <th style="padding:6px 12px;text-align:left;">Count</th>
            <th style="padding:6px 12px;text-align:left;">Price</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>`
    })
    .join('')

  const html = `
    <p>Capacity opened across the cascade. ${cells.length} new (provider, tier, count) cell${cells.length === 1 ? '' : 's'} just became available:</p>
    ${sections}
    <p style="color:#666;font-size:12px;margin-top:16px;">
      Re-alerts suppressed for 1h per (provider, tier, count). When a cell goes back to no-capacity, its dedupe key clears so the next opening re-fires.
      Set CASCADE_WATCH_ENABLED=false on the API to silence. Default tick: 5 min.
    </p>
  `.trim()

  const tierLabel = cells.length === 1
    ? `${cells[0]!.provider} ${cells[0]!.tier} x${cells[0]!.count}`
    : `${cells.length} cells across ${byProvider.size} providers`

  await sendEmail(
    recipient,
    `[TokenOS] Capacity opened: ${tierLabel}`,
    html,
  )
}
