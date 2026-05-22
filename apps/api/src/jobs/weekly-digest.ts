/**
 * C3 wave 2: weekly digest worker.
 *
 * Every Monday 09:00 UTC (env-tunable via DIGEST_DAY / DIGEST_HOUR /
 * DIGEST_INTERVAL_MS), iterate every NodeRunner who:
 *   - has an email on file
 *   - has firstHeartbeatAt set (real operator, not a stub)
 *   - has at least one node with a heartbeat in the last 30 days
 *   - has not opted out (digestOptedOut=false)
 *
 * Per operator, build a "Your Compute Weekly Report" email containing:
 *   - the same forecast as the dashboard card (services/earnings/forecast)
 *   - uptime warnings for any node under 90% uptime over the last 30d
 *
 * If SMTP is not configured, the worker no-ops with a single log line
 * per tick (the email sender already gates the per-call warning so the
 * pm2 logs don't flood).
 *
 * Pattern follows referral-commission.ts: a Queue + a Worker + a
 * schedule helper + a pure tick function so the digest:run-once script
 * can invoke the tick logic synchronously for manual testing.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { calculateForecast, type ForecastResult } from '../services/earnings/forecast.js'
import { calculateNodeUptime } from '../services/earnings/uptime-calculator.js'
import { isEmailConfigured, sendEmail } from '../services/email/sender.js'

const QUEUE_NAME = 'weekly-digest'

const TICK_INTERVAL_MS = parseInt(
  process.env.DIGEST_INTERVAL_MS ?? `${7 * 24 * 60 * 60 * 1000}`,
  10,
)
const PORTAL_URL = process.env.PORTAL_URL ?? 'https://user.tokenos.ai'
const UPTIME_WARNING_THRESHOLD_PCT = parseFloat(process.env.DIGEST_UPTIME_WARN_PCT ?? '90')

interface DigestDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createWeeklyDigestQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 12 },
      removeOnFail: { count: 60 },
    },
  })
}

export function createWeeklyDigestWorker(deps: DigestDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runWeeklyDigestTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleWeeklyDigest(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

interface NodeWarning {
  nodeId: string
  gpuTier: string
  uptimePct: number
}

interface DigestPayload {
  operatorName: string
  forecast: ForecastResult
  warnings: NodeWarning[]
}

/**
 * Run a single digest tick. Returns a summary the run-once script can
 * print so the operator confirming a manual fire has something to see.
 */
export async function runWeeklyDigestTick(
  prisma: PrismaClient,
  options: { targetEmail?: string } = {},
): Promise<{ sent: number; skipped: number; reasonsSkipped: Record<string, number> }> {
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  if (!(await isEmailConfigured())) {
    // eslint-disable-next-line no-console
    console.warn('[weekly-digest] SMTP not configured — skipping tick. Set smtp_host + smtp_from in the Config table to enable.')
    return { sent: 0, skipped: 0, reasonsSkipped: { unconfigured: 1 } }
  }

  // Pool of candidates: every NodeRunner with an email and at least one
  // node that's heartbeated in the last 30 days. The orderBy keeps the
  // tick deterministic so the digest:run-once script always processes
  // operators in the same order.
  const candidates = await prisma.nodeRunner.findMany({
    where: {
      email: { not: null },
      firstHeartbeatAt: { not: null },
      digestOptedOut: false,
      ...(options.targetEmail ? { email: options.targetEmail } : {}),
    },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: 'asc' },
  })

  let sent = 0
  const reasonsSkipped: Record<string, number> = {}

  for (const nr of candidates) {
    if (!nr.email) {
      reasonsSkipped.noEmail = (reasonsSkipped.noEmail ?? 0) + 1
      continue
    }

    // Skip operators with no recent activity. Avoids spamming inboxes
    // for runners who disconnected weeks ago.
    const recentHeartbeat = await prisma.node.count({
      where: {
        nodeRunnerId: nr.id,
        lastHeartbeat: { gte: thirtyDaysAgo },
      },
    })
    if (recentHeartbeat === 0) {
      reasonsSkipped.inactive = (reasonsSkipped.inactive ?? 0) + 1
      continue
    }

    const forecast = await calculateForecast(prisma, nr.id, 30)

    // Uptime warnings — surface any node below the threshold across
    // the last 30 days. 30 days is a long enough window that a single
    // bad day doesn't trigger noise.
    const nodes = await prisma.node.findMany({
      where: { nodeRunnerId: nr.id },
      select: { id: true, gpuTier: true, customGpuModel: true },
    })

    const warnings: NodeWarning[] = []
    for (const node of nodes) {
      const uptimeSeconds = await calculateNodeUptime(prisma, node.id, thirtyDaysAgo, now)
      const periodSeconds = (now.getTime() - thirtyDaysAgo.getTime()) / 1000
      const uptimePct = (uptimeSeconds / periodSeconds) * 100
      if (uptimePct < UPTIME_WARNING_THRESHOLD_PCT) {
        warnings.push({
          nodeId: node.id,
          gpuTier: node.customGpuModel ?? node.gpuTier,
          uptimePct: Math.round(uptimePct * 10) / 10,
        })
      }
    }

    const html = renderDigestHtml({
      operatorName: nr.name ?? 'there',
      forecast,
      warnings,
    })
    const ok = await sendEmail(nr.email, 'Your Compute Weekly Report', html)
    if (ok) {
      sent += 1
    } else {
      reasonsSkipped.sendFailed = (reasonsSkipped.sendFailed ?? 0) + 1
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[weekly-digest] candidates=${candidates.length} sent=${sent} skipped=${JSON.stringify(reasonsSkipped)}`,
  )

  return { sent, skipped: candidates.length - sent, reasonsSkipped }
}

export function renderDigestHtml(payload: DigestPayload): string {
  const { operatorName, forecast, warnings } = payload

  const insufficientData = forecast.daysAnalyzed < 5
  const forecastBlock = insufficientData
    ? `
        <p style="margin: 0; color: #cbd5e1; font-size: 14px;">
          Not enough recent earnings data yet to forecast (need 5+ active days).
          Once your nodes have been online for a week or so, the next digest
          will include a 30-day projection.
        </p>
      `
    : `
        <p style="margin: 0 0 8px 0; font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.16em;">
          Expected next 30 days
        </p>
        <p style="margin: 0; font-size: 32px; font-weight: 700; color: #22c55e;">
          $${forecast.projected.toFixed(2)}
        </p>
        <p style="margin: 8px 0 0 0; font-size: 13px; color: #a1a1aa;">
          Range $${forecast.rangeLow.toFixed(2)} – $${forecast.rangeHigh.toFixed(2)}
        </p>
        <p style="margin: 8px 0 0 0; font-size: 12px; color: #71717a;">
          Based on the last ${forecast.daysAnalyzed} active days.
        </p>
      `

  const warningsBlock = warnings.length === 0
    ? `
        <p style="margin: 0; color: #a1a1aa; font-size: 14px;">
          All your nodes are above ${UPTIME_WARNING_THRESHOLD_PCT}% uptime over the last 30 days. Nothing to look at.
        </p>
      `
    : `
        <ul style="margin: 0; padding: 0 0 0 18px; color: #e2e8f0; font-size: 14px;">
          ${warnings
            .map(
              (w) => `
                <li style="margin-bottom: 8px;">
                  <strong style="color: #f87171;">${escapeHtml(w.gpuTier)}</strong>
                  &mdash; ${w.uptimePct.toFixed(1)}% uptime (target &ge;${UPTIME_WARNING_THRESHOLD_PCT}%).
                  Common causes: thermal throttle, driver, network.
                </li>
              `,
            )
            .join('')}
        </ul>
      `

  // Body html — wraps in the sender's wrapTemplate styling at send time.
  return `
    <h2 style="margin: 0 0 16px 0; font-size: 20px; color: #fafafa;">Your Compute Weekly Report</h2>
    <p style="margin: 0 0 24px 0; font-size: 14px; color: #cbd5e1;">
      Hi ${escapeHtml(operatorName)}, here's what your operator account looks like this week.
    </p>

    <div style="background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 20px; margin-bottom: 24px;">
      ${forecastBlock}
    </div>

    <h3 style="margin: 0 0 12px 0; font-size: 15px; color: #fafafa;">
      ${warnings.length === 0 ? 'Uptime health' : `Nodes to investigate (${warnings.length})`}
    </h3>
    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      ${warningsBlock}
    </div>

    <p style="margin: 24px 0 0 0; font-size: 13px; color: #a1a1aa;">
      <a href="${PORTAL_URL}/dashboard" style="color: #22c55e; text-decoration: none; margin-right: 16px;">View dashboard &rarr;</a>
      <a href="${PORTAL_URL}/payouts/settings" style="color: #22c55e; text-decoration: none;">Payout settings &rarr;</a>
    </p>
    <p style="margin: 16px 0 0 0; font-size: 12px; color: #71717a;">
      Don't want these? Turn off the weekly summary on the payout settings page.
    </p>
  `
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
