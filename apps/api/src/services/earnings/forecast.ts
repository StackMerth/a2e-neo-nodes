/**
 * C3 wave 2: earnings forecast helper.
 *
 * Simple 7-day moving average projected forward `days` days, with a
 * +/-15% conservative band. The band is intentionally wide so operators
 * read it as "your floor and ceiling if patterns hold" rather than
 * "exactly this much."
 *
 * Cold-start: when fewer than 5 days of earnings exist, callers should
 * surface "Insufficient data" instead of the headline number. The
 * `daysAnalyzed` field on the response lets the UI make that call.
 *
 * Shared between the GET /v1/portal/node-runner/earnings/forecast
 * endpoint and the weekly-digest worker so the dashboard card and the
 * digest email never disagree.
 */

import type { PrismaClient } from '@a2e/database'
import { getDailyUptimeBreakdown } from './uptime-calculator.js'

export interface ForecastResult {
  /** Forward-looking projection over the requested days. */
  projected: number
  /** Lower bound of the +/-15% conservative range. */
  rangeLow: number
  /** Upper bound of the +/-15% conservative range. */
  rangeHigh: number
  /** Average daily earnings used as the per-day extrapolation rate. */
  avgDailyEarnings: number
  /** Number of days in the trailing window that had non-zero earnings. */
  daysAnalyzed: number
  /** Lookback window the average was computed from (always 7). */
  basedOn: string
  /** How many days into the future the projection spans. */
  horizonDays: number
}

const LOOKBACK_DAYS = 7
const CONSERVATIVE_BAND = 0.15

/**
 * Compute the earnings forecast for a node runner.
 *
 * Sums daily earnings across every node the runner owns over the
 * trailing 7 days, divides by the count of non-zero days to get an
 * honest avg-when-earning rate, then projects forward.
 *
 * We deliberately divide by `daysAnalyzed` (non-zero count) rather than
 * 7 so a brand-new operator with 2 days of strong earnings is not
 * deflated by 5 days of zero. This is the "if patterns hold" framing.
 */
export async function calculateForecast(
  prisma: PrismaClient,
  nodeRunnerId: string,
  horizonDays: number = 30,
): Promise<ForecastResult> {
  const nodes = await prisma.node.findMany({
    where: { nodeRunnerId },
    select: { id: true },
  })

  // Sum daily earnings across all the runner's nodes for the last 7
  // days. Reuses getDailyUptimeBreakdown so the forecast math lines up
  // with whatever the dashboard already shows for daily uptime.
  const dayTotals: Record<string, number> = {}
  for (const node of nodes) {
    const breakdown = await getDailyUptimeBreakdown(prisma, node.id, LOOKBACK_DAYS)
    for (const day of breakdown) {
      dayTotals[day.date] = (dayTotals[day.date] ?? 0) + day.earnings
    }
  }

  const earningDays = Object.values(dayTotals).filter(v => v > 0)
  const daysAnalyzed = earningDays.length
  const totalRecent = earningDays.reduce((a, b) => a + b, 0)
  const avgDailyEarnings = daysAnalyzed > 0 ? totalRecent / daysAnalyzed : 0

  const projected = avgDailyEarnings * horizonDays
  const rangeLow = projected * (1 - CONSERVATIVE_BAND)
  const rangeHigh = projected * (1 + CONSERVATIVE_BAND)

  return {
    projected: Math.round(projected * 100) / 100,
    rangeLow: Math.round(rangeLow * 100) / 100,
    rangeHigh: Math.round(rangeHigh * 100) / 100,
    avgDailyEarnings: Math.round(avgDailyEarnings * 100) / 100,
    daysAnalyzed,
    basedOn: `last ${LOOKBACK_DAYS} days average`,
    horizonDays,
  }
}
