/**
 * Cascade-wide capacity snapshot watcher.
 *
 * Companion to the per-provider capacity watchers (lambda-, vastai-,
 * ionet-capacity-watcher). Those alert on state transitions ("X just
 * opened on Lambda"). This snapshot is the inverse: a periodic FULL
 * REPORT of every (provider, tier, count) cell across the cascade,
 * showing what is currently available AND what is not.
 *
 * Useful when an operator wants the ground truth of "what does the
 * marketplace look like right now" without configuring per-SKU watch
 * lists. The per-provider watchers are still the right tool when you
 * are specifically waiting for an oversubscribed SKU to flip; this
 * snapshot is for the daily "everything view".
 *
 * Implementation reuses probeAllProvidersDebug from capacity-probe.ts
 * so the matrix reflects EXACTLY what the cascade would see at probe
 * time, including allocator gates (IONET_ALLOCATOR_ENABLED etc.),
 * geo-filter results on Vast.ai, and reliability thresholds. If a row
 * shows 'allocator_disabled' the operator knows the cascade is
 * actively skipping that provider, not that the provider is empty.
 *
 * Configuration:
 *   CASCADE_SNAPSHOT_TICK_MS      Default 86_400_000 (24h). Override
 *                                 down to hours if you want a faster
 *                                 cadence; below 1h is wasteful given
 *                                 the report is meant for human review.
 *   CASCADE_SNAPSHOT_EMAIL        Recipient. Falls back to
 *                                 LAMBDA_CAPACITY_WATCH_EMAIL so admins
 *                                 don't have to set both.
 *   CASCADE_SNAPSHOT_TIERS        Comma-separated GpuTier list to
 *                                 include. Default: all datacenter +
 *                                 consumer tiers we expose internally.
 *   CASCADE_SNAPSHOT_COUNTS       Comma-separated counts. Default: 1,8.
 *   CASCADE_SNAPSHOT_DISABLED     'true' to no-op (useful in dev /
 *                                 staging where the email is noise).
 *
 * No Redis dedupe: every tick sends a fresh digest by design. If you
 * want change-only alerts, use the per-provider watchers instead.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { GpuTier } from '@a2e/database'
import { probeAllProvidersDebug, type CapacityQuote, type ProviderKey } from '../services/inbound/capacity-probe.js'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'
import { resolveCapacityWatchRecipient } from '../services/email/capacity-recipient.js'

const QUEUE_NAME = 'cascade-capacity-snapshot'
const TICK_INTERVAL_MS = parseInt(
  process.env.CASCADE_SNAPSHOT_TICK_MS ?? `${24 * 60 * 60 * 1000}`,
  10,
)

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

const PROVIDER_ORDER: ProviderKey[] = [
  'LAMBDA',
  'RUNPOD',
  'IONET',
  'PHALA',
  'VOLTAGEGPU',
  'VASTAI',
  'SHADEFORM',
]

interface WatcherDeps {
  redis: ConnectionOptions
}

interface CellSnapshot {
  tier: GpuTier
  count: number
  quotes: Record<ProviderKey, CapacityQuote | undefined>
  cheapestProvider: ProviderKey | null
}

export function createCascadeCapacitySnapshotQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createCascadeCapacitySnapshotWorker(deps: WatcherDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runCascadeCapacitySnapshotTick()
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleCascadeCapacitySnapshot(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

function parseTiers(): GpuTier[] {
  const raw = process.env.CASCADE_SNAPSHOT_TIERS?.trim()
  if (!raw) return DEFAULT_TIERS
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase() as GpuTier)
    .filter(Boolean)
}

function parseCounts(): number[] {
  const raw = process.env.CASCADE_SNAPSHOT_COUNTS?.trim()
  if (!raw) return DEFAULT_COUNTS
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

export async function runCascadeCapacitySnapshotTick(): Promise<{
  cells: CellSnapshot[]
  emailSent: boolean
}> {
  if (process.env.CASCADE_SNAPSHOT_DISABLED?.toLowerCase() === 'true') {
    return { cells: [], emailSent: false }
  }

  const tiers = parseTiers()
  const counts = parseCounts()

  // Probe every cell in the matrix. probeAllProvidersDebug returns
  // even the no-capacity rows (with a reasonNoCapacity), so we get
  // the full ground truth not just the winners.
  const cells: CellSnapshot[] = []
  for (const tier of tiers) {
    for (const count of counts) {
      const quotes = await probeAllProvidersDebug(tier, count, {
        preferConfidential: false,
      })
      const byProvider: Record<string, CapacityQuote> = {}
      for (const q of quotes) byProvider[q.provider] = q

      const withCapacity = quotes
        .filter((q) => q.hasCapacity)
        .sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)
      const cheapestProvider = withCapacity[0]?.provider ?? null

      cells.push({
        tier,
        count,
        quotes: byProvider as Record<ProviderKey, CapacityQuote | undefined>,
        cheapestProvider,
      })
    }
  }

  const emailSent = await sendSnapshotDigest(cells)
  return { cells, emailSent }
}

async function sendSnapshotDigest(cells: CellSnapshot[]): Promise<boolean> {
  if (!(await isEmailConfigured())) {
    console.log('[cascade-capacity-snapshot] email not configured; skipping digest send.')
    return false
  }
  const recipient = (
    process.env.CASCADE_SNAPSHOT_EMAIL?.trim()
    || resolveCapacityWatchRecipient()
  )
  if (!recipient) {
    console.log('[cascade-capacity-snapshot] no recipient set; skipping digest send.')
    return false
  }

  const html = buildHtml(cells)
  const today = new Date().toISOString().slice(0, 10)
  await sendEmail(
    recipient,
    `[TokenOS] Cascade capacity snapshot: ${today}`,
    html,
  )
  return true
}

function buildHtml(cells: CellSnapshot[]): string {
  // Header row: SKU column + one per provider.
  const headerCells = ['<th style="padding:8px 12px;text-align:left;background:#f6f6f6;">SKU</th>']
  for (const p of PROVIDER_ORDER) {
    headerCells.push(`<th style="padding:8px 12px;text-align:left;background:#f6f6f6;">${p}</th>`)
  }
  headerCells.push('<th style="padding:8px 12px;text-align:left;background:#f6f6f6;">Cheapest</th>')

  // Data rows.
  const rows = cells
    .map((cell) => {
      const skuLabel = `${cell.tier} (${cell.count}x)`
      const cellsHtml = PROVIDER_ORDER.map((p) => {
        const q = cell.quotes[p]
        return renderCell(q)
      }).join('')
      const cheapestStr = cell.cheapestProvider
        ? `${cell.cheapestProvider} $${cell.quotes[cell.cheapestProvider]!.pricePerHourUsd.toFixed(2)}/h`
        : 'none'
      return `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;">${skuLabel}</td>
          ${cellsHtml}
          <td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;">${cheapestStr}</td>
        </tr>`
    })
    .join('')

  return `
    <p>Cascade-wide capacity snapshot. Green cells show available capacity (price/hour). Red cells show no capacity with the reason. Gray cells are unmapped on that provider.</p>
    <table style="border-collapse:collapse;margin:16px 0;font-size:13px;">
      <thead><tr>${headerCells.join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#666;font-size:12px;">
      Generated by cascade-capacity-snapshot worker. Tick interval is set via CASCADE_SNAPSHOT_TICK_MS env (default 24h).
      Per-provider watchers (Lambda / Vast.ai / io.net) fire separately on state transitions when configured.
    </p>
  `.trim()
}

function renderCell(q: CapacityQuote | undefined): string {
  if (!q) {
    return '<td style="padding:6px 12px;border-bottom:1px solid #eee;background:#fafafa;color:#999;">not probed</td>'
  }
  if (q.hasCapacity) {
    return `<td style="padding:6px 12px;border-bottom:1px solid #eee;background:#e8f5e9;color:#2e7d32;font-weight:600;">$${q.pricePerHourUsd.toFixed(2)}/h</td>`
  }
  // No capacity. Distinguish "not mapped" (gray) from "real no-capacity" (red).
  const reason = q.reasonNoCapacity ?? 'no_capacity'
  if (reason === 'tier_unmapped' || reason === 'exceeds_per_instance_max' || reason === 'exceeds_per_pod_max' || reason === 'exceeds_per_vm_max' || reason === 'exceeds_per_cvm_max' || reason === 'exceeds_per_host_max') {
    return `<td style="padding:6px 12px;border-bottom:1px solid #eee;background:#fafafa;color:#999;font-style:italic;">${reason}</td>`
  }
  return `<td style="padding:6px 12px;border-bottom:1px solid #eee;background:#ffebee;color:#c62828;">${reason}</td>`
}
