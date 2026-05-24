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

interface PricingTip {
  // A short, scannable one-line label rendered as a bullet in the
  // digest. Generated from the operator's last-30d rental mix so the
  // tips feel personalized rather than evergreen marketing copy.
  text: string
}

interface TaxReminder {
  // Sum of completed earnings since Jan 1 of the current year. Drives
  // the urgency tier (must-file vs nice-to-have-on-file).
  ytdEarnings: number
  // Whether the operator already submitted a W-9. From NodeRunner.
  w9OnFile: boolean
  // US 1099-MISC threshold check. Operators above this need a W-9 on
  // file before tax season; the digest nudges them.
  crossesIrsThreshold: boolean
}

interface DigestPayload {
  operatorName: string
  forecast: ForecastResult
  warnings: NodeWarning[]
  pricingTips: PricingTip[]
  taxReminder: TaxReminder | null
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

  // Pool of candidates: every NodeRunner with a verified email and at
  // least one node that's heartbeated in the last 30 days. The
  // emailVerified gate stops the worker from spamming inboxes that
  // were never confirmed (anti-abuse + Resend deliverability). The
  // orderBy keeps the tick deterministic so the digest:run-once
  // script always processes operators in the same order.
  const candidates = await prisma.nodeRunner.findMany({
    where: {
      email: { not: null },
      firstHeartbeatAt: { not: null },
      digestOptedOut: false,
      // Email verification gate. Unverified accounts get no digest;
      // they'll start receiving it the next Monday after they click
      // the verification link.
      user: { is: { emailVerified: true } },
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

    const pricingTips = await computePricingTips(prisma, nr.id, thirtyDaysAgo, now)
    const taxReminder = await computeTaxReminder(prisma, nr.id, now)

    const html = renderDigestHtml({
      operatorName: nr.name ?? 'there',
      forecast,
      warnings,
      pricingTips,
      taxReminder,
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
  const { operatorName, forecast, warnings, pricingTips, taxReminder } = payload

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

    ${
      pricingTips.length === 0
        ? ''
        : `
            <h3 style="margin: 0 0 12px 0; font-size: 15px; color: #fafafa;">
              Pricing tips
            </h3>
            <div style="background: rgba(59, 130, 246, 0.06); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 8px; padding: 16px; margin-bottom: 24px;">
              <ul style="margin: 0; padding: 0 0 0 18px; color: #e2e8f0; font-size: 14px;">
                ${pricingTips
                  .map(
                    (tip) => `
                      <li style="margin-bottom: 10px; line-height: 1.5;">
                        ${escapeHtml(tip.text)}
                      </li>
                    `,
                  )
                  .join('')}
              </ul>
            </div>
          `
    }

    ${
      taxReminder === null
        ? ''
        : renderTaxBlock(taxReminder)
    }

    <p style="margin: 24px 0 0 0; font-size: 13px; color: #a1a1aa;">
      <a href="${PORTAL_URL}/dashboard" style="color: #22c55e; text-decoration: none; margin-right: 16px;">View dashboard &rarr;</a>
      <a href="${PORTAL_URL}/payouts/settings" style="color: #22c55e; text-decoration: none;">Payout settings &rarr;</a>
    </p>
    <p style="margin: 16px 0 0 0; font-size: 12px; color: #71717a;">
      Don't want these? Turn off the weekly summary on the payout settings page.
    </p>
  `
}

function renderTaxBlock(reminder: TaxReminder): string {
  const ytdFmt = reminder.ytdEarnings.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
  // Three tiers of urgency:
  //   1. Crossed $600 + no W-9 on file  -> amber, "needs your attention"
  //   2. Crossed $600 + W-9 on file     -> green, "you're set, csv ready"
  //   3. Below $600                     -> grey, "heads up for later"
  const needsAttention = reminder.crossesIrsThreshold && !reminder.w9OnFile
  const onTrack = reminder.crossesIrsThreshold && reminder.w9OnFile

  const bgRgba = needsAttention
    ? 'rgba(245, 158, 11, 0.08)'
    : onTrack
      ? 'rgba(34, 197, 94, 0.06)'
      : 'rgba(255, 255, 255, 0.02)'
  const borderRgba = needsAttention
    ? 'rgba(245, 158, 11, 0.35)'
    : onTrack
      ? 'rgba(34, 197, 94, 0.3)'
      : 'rgba(255, 255, 255, 0.1)'
  const headlineColor = needsAttention ? '#f59e0b' : onTrack ? '#22c55e' : '#a1a1aa'

  const body = needsAttention
    ? `
        <p style="margin: 0 0 10px 0; color: #fbbf24; font-size: 14px; font-weight: 600;">
          You've earned $${ytdFmt} this year and crossed the US 1099-MISC threshold.
        </p>
        <p style="margin: 0 0 14px 0; color: #e2e8f0; font-size: 14px; line-height: 1.5;">
          Add your W-9 info on the settings page so we can issue your 1099 at year-end. Five minutes; takes legal name, TIN, and address. Stored privately, never shared with buyers.
        </p>
        <a href="${PORTAL_URL}/settings" style="display: inline-block; background: #f59e0b; color: #0a0a0f; padding: 8px 16px; text-decoration: none; font-size: 13px; font-weight: 600; border-radius: 4px;">
          Submit W-9 &rarr;
        </a>
      `
    : onTrack
      ? `
          <p style="margin: 0 0 10px 0; color: #4ade80; font-size: 14px; font-weight: 600;">
            $${ytdFmt} earned this year. W-9 on file.
          </p>
          <p style="margin: 0 0 14px 0; color: #e2e8f0; font-size: 14px; line-height: 1.5;">
            When tax season hits, your 1099-MISC will be ready. You can also download the year-to-date CSV anytime for your CPA.
          </p>
          <a href="${PORTAL_URL}/settings" style="display: inline-block; background: rgba(255,255,255,0.06); color: #22c55e; padding: 8px 16px; text-decoration: none; font-size: 13px; font-weight: 600; border-radius: 4px; border: 1px solid rgba(34,197,94,0.3);">
            Download CSV &rarr;
          </a>
        `
      : `
          <p style="margin: 0; color: #a1a1aa; font-size: 14px; line-height: 1.5;">
            $${ytdFmt} earned this year so far. If you cross the $600 US 1099-MISC threshold this year, you'll want to have W-9 info on file — heads up so you're not scrambling in January.
          </p>
        `

  return `
    <h3 style="margin: 0 0 12px 0; font-size: 15px; color: ${headlineColor};">
      Tax-season reminder
    </h3>
    <div style="background: ${bgRgba}; border: 1px solid ${borderRgba}; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
      ${body}
    </div>
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

/**
 * Compute 2-3 personalized pricing tips for the operator. Tips are
 * pulled from a small ranked pool based on the operator's actual
 * 30-day data so the digest does not read as generic marketing copy.
 *
 * Each tip is one scannable line, max ~120 chars, written so the
 * operator can take action without clicking through to the dashboard.
 */
async function computePricingTips(
  prisma: PrismaClient,
  nodeRunnerId: string,
  thirtyDaysAgo: Date,
  now: Date,
): Promise<PricingTip[]> {
  const tips: PricingTip[] = []

  // Pull recent ComputeRequest rows allocated to this operator's
  // nodes so we can introspect tier mix, region distribution, and
  // average rental size.
  const nodes = await prisma.node.findMany({
    where: { nodeRunnerId },
    select: { id: true, region: true, gpuTier: true },
  })
  const nodeIds = nodes.map((n) => n.id)
  if (nodeIds.length === 0) return tips

  const recentRequests = await prisma.computeRequest.findMany({
    where: {
      allocatedNodeIds: { hasSome: nodeIds },
      requestedAt: { gte: thirtyDaysAgo, lte: now },
      status: { in: ['ACTIVE', 'COMPLETED'] },
    },
    select: { tier: true, durationDays: true, totalCost: true },
  })

  // Tip 1: pricing-tier mix. If >70% of rentals are ON_DEMAND the
  // operator could be capturing SPOT-tier demand without losing
  // much, because SPOT rentals are preemptible (lower commitment).
  const total = recentRequests.length
  if (total >= 3) {
    const onDemandShare = recentRequests.filter((r) => r.tier === 'ON_DEMAND').length / total
    const reservedShare = recentRequests.filter((r) => r.tier === 'RESERVED').length / total
    if (onDemandShare > 0.7) {
      tips.push({
        text: `${Math.round(onDemandShare * 100)}% of your rentals were ON_DEMAND. Tagging more nodes as SPOT-eligible captures the discounted-tier buyers without a long-term commitment.`,
      })
    } else if (reservedShare < 0.1 && total >= 5) {
      tips.push({
        text: 'Almost none of your rentals are RESERVED. Encouraging buyers to commit (7/30/90 day) gives them a discount and you predictable utilization.',
      })
    }
  }

  // Tip 2: region concentration. If all nodes share a single region
  // the operator is missing demand in the others. Cheap diversifier.
  const regions = new Set(nodes.map((n) => n.region).filter(Boolean))
  if (nodes.length >= 2 && regions.size === 1) {
    const region = [...regions][0]
    tips.push({
      text: `All your nodes are in ${region ?? 'one region'}. Spreading across regions lets buyers with latency constraints discover you.`,
    })
  }

  // Tip 3: evergreen suggestion for operators with strong recent
  // earnings — promote longer-tier rentals via dashboard prompts.
  // Shown when nothing data-driven fired so the digest still has
  // an actionable tip for every operator.
  if (tips.length === 0) {
    tips.push({
      text: 'Add a few notes to your operator profile (hardware photos, network speed, prior workloads). Buyers using the marketplace listings page filter by reputation; richer profiles convert better at the same price.',
    })
  }

  // Cap at 3 so the email stays scannable.
  return tips.slice(0, 3)
}

/**
 * Compute a tax-season reminder for the operator. Returns null when
 * the operator's YTD earnings are too small to bother with (sub-$50)
 * so the digest does not pester hobbyists about IRS paperwork.
 *
 * Crosses-IRS-threshold ($600 = 1099-MISC filing requirement in the
 * US) bumps the reminder urgency and adds a "missing W-9" warning
 * when the operator has not submitted tax info yet.
 */
async function computeTaxReminder(
  prisma: PrismaClient,
  nodeRunnerId: string,
  now: Date,
): Promise<TaxReminder | null> {
  const jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))

  // Aggregate earnings for the operator since Jan 1.
  const ytdAgg = await prisma.earning.aggregate({
    where: {
      node: { nodeRunnerId },
      date: { gte: jan1 },
    },
    _sum: { earnings: true },
  })
  const ytdEarnings = Number(ytdAgg._sum.earnings ?? 0)

  // Don't pester hobbyists who earned a few dollars.
  if (ytdEarnings < 50) return null

  const profile = await prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: { w9SubmittedAt: true },
  })

  return {
    ytdEarnings,
    w9OnFile: !!profile?.w9SubmittedAt,
    crossesIrsThreshold: ytdEarnings >= 600,
  }
}
