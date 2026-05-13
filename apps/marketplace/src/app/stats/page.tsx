/*
 * M5.10 + M4.x.k: Explorer-style network stats page.
 *
 * Public, server-rendered, 30s revalidate. Two fetches in parallel:
 *   - /v1/public/stats             (snapshot: nodes online, operators, regions, CO2)
 *   - /v1/public/network-analytics (trajectory: revenue, projections, rate history)
 *
 * Charts are inline SVG so the page stays SSR and ships no chart JS.
 * Visual is loyal to the editorial palette: cream, ink, Instrument
 * Serif headlines, JetBrains Mono for numerics and labels. No glow,
 * no decorative badges, no fake bar charts.
 */

import Link from 'next/link'
import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

export const revalidate = 30

interface StatsResponse {
  timestamp: string
  totalNodesOnline: number
  totalOperatorsOnline: number
  totalRentalsLifetime: number
  totalComputeMinutesLifetime: number
  totalCo2GramsLifetime: number
  nodesByTier: Array<{ gpuTier: string; count: number }>
  regionDistribution: Array<{ region: string; count: number }>
  topPricesByTier: Array<{ gpuTier: string; ratePerHour: number; ratePerMinute: number }>
}

interface AnalyticsResponse {
  timestamp: string
  dailyRevenue: Array<{ date: string; revenue: number }>
  monthlyPerformance: Array<{ month: string; revenue: number; payouts: number; buyerSpend: number }>
  projections: {
    daily:   { current: number; projected: number; growthPct: number }
    weekly:  { current: number; projected: number; growthPct: number }
    monthly: { current: number; projected: number; growthPct: number }
  }
  monthlyProjectionGrowth: Array<{ month: string; projected: number }>
  returnsVsCost: {
    totalCostBasis: number
    totalEarnings: number
    recoupRatio: number
    monthlyAvgEarnings: number
    breakEvenMonths: number | null
  }
  noderunnerGrowth: Array<{ date: string; total: number }>
  powerUsers: Array<{ date: string; count: number }>
  rateHistory: Record<string, Array<{ date: string; ratePerHour: number }>>
  rateTable: Array<{ gpuTier: string; current: number; median30d: number; min30d: number; max30d: number; deltaPct30d: number }>
}

async function fetchStats(): Promise<StatsResponse | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/stats`, { next: { revalidate: 30 } })
    if (!res.ok) return null
    return (await res.json()) as StatsResponse
  } catch {
    return null
  }
}

async function fetchAnalytics(): Promise<AnalyticsResponse | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/network-analytics`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    return (await res.json()) as AnalyticsResponse
  } catch {
    return null
  }
}

export const metadata = {
  title: 'Stats',
  description: 'Live network stats and 3-month projections for the TokenOS DeAI GPU compute marketplace.',
  openGraph: {
    title: 'TokenOS DeAI network stats',
    description: 'Live network stats and projections for the TokenOS DeAI GPU compute marketplace.',
    images: [{ url: '/og?type=marketplace', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image' as const,
    images: ['/og?type=marketplace'],
  },
}

// ---------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n)
const fmtUsdShort = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000)    return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}k`
  return fmtUsd(n)
}
const fmtMonth = (key: string) => {
  const [y, m] = key.split('-')
  if (!y || !m) return key
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// ---------------------------------------------------------------------
// Inline SVG primitives (server-rendered, no JS shipped)
// ---------------------------------------------------------------------

function Sparkline({ values, width = 320, height = 60, accent = false }: {
  values: number[]; width?: number; height?: number; accent?: boolean
}) {
  if (values.length === 0) return null
  const max = Math.max(...values, 0.0001)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const step = width / Math.max(1, values.length - 1)
  const points = values.map((v, i) => {
    const x = i * step
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const area = `M0,${height} L${points.join(' L')} L${width},${height} Z`
  const stroke = accent ? 'currentColor' : 'currentColor'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block">
      <path d={area} fill="currentColor" fillOpacity={accent ? 0.12 : 0.08} />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MiniBars({ values, width = 320, height = 60 }: { values: number[]; width?: number; height?: number }) {
  if (values.length === 0) return null
  const max = Math.max(...values, 0.0001)
  const slot = width / values.length
  const barW = Math.max(2, slot - 2)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block">
      {values.map((v, i) => {
        const h = (v / max) * (height - 2)
        const x = i * slot + (slot - barW) / 2
        const y = height - h
        return <rect key={i} x={x.toFixed(2)} y={y.toFixed(2)} width={barW.toFixed(2)} height={h.toFixed(2)} fill="currentColor" />
      })}
    </svg>
  )
}

// Multi-series line chart for rate history. Each series gets its own
// stroke shade (varying opacity) since the page is monochrome.
function MultiLine({ series, width = 600, height = 200 }: {
  series: Array<{ name: string; values: number[] }>
  width?: number
  height?: number
}) {
  if (series.length === 0) return null
  const allValues = series.flatMap(s => s.values)
  if (allValues.length === 0) return null
  const max = Math.max(...allValues, 0.0001)
  const min = Math.min(...allValues, 0)
  const range = max - min || 1
  const maxLen = Math.max(...series.map(s => s.values.length))
  const step = width / Math.max(1, maxLen - 1)
  const shades = [1, 0.7, 0.5, 0.35, 0.22]
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {series.map((s, idx) => {
        const points = s.values.map((v, i) => {
          const x = i * step
          const y = height - ((v - min) / range) * (height - 12) - 6
          return `${x.toFixed(2)},${y.toFixed(2)}`
        })
        return (
          <polyline
            key={s.name}
            points={points.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeOpacity={shades[idx] ?? 0.15}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default async function StatsPage() {
  const [data, analytics] = await Promise.all([fetchStats(), fetchAnalytics()])
  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <p className="font-mono text-sm text-muted-foreground">
          Stats temporarily unavailable.
        </p>
      </main>
    )
  }

  const maxRegionCount = Math.max(1, ...data.regionDistribution.map(r => r.count))
  const totalHoursLifetime = data.totalComputeMinutesLifetime / 60

  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />

      <section className="pt-24 sm:pt-32 lg:pt-40 pb-10 sm:pb-12 lg:pb-16 px-6 lg:px-12">
        <div className="max-w-[1200px] mx-auto">
          <div className="flex flex-wrap items-center gap-3 mb-6 sm:mb-8">
            <span className="w-8 h-px bg-foreground/30" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Network stats
            </span>
            <span className="hidden sm:block flex-1 h-px bg-foreground/10" />
            <span className="font-mono text-xs text-muted-foreground">
              Updated {new Date(data.timestamp).toLocaleString()}
            </span>
          </div>
          <h1 className="font-display text-4xl sm:text-5xl md:text-7xl leading-[0.95] tracking-tight text-foreground mb-4 sm:mb-6 max-w-3xl">
            The numbers, in the open.
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Direct readouts from the database, refreshed every 30 seconds. Nothing here is forecast, projected, or aspirational unless we mark it that way.
          </p>
        </div>
      </section>

      {/* Top-line counters */}
      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-foreground/15">
          <BigStat label="GPUs online" value={data.totalNodesOnline.toLocaleString()} unit={data.totalNodesOnline === 1 ? 'machine' : 'machines'} />
          <BigStat label="Operators live" value={data.totalOperatorsOnline.toLocaleString()} unit={data.totalOperatorsOnline === 1 ? 'operator' : 'operators'} />
          <BigStat label="Lifetime rentals" value={data.totalRentalsLifetime.toLocaleString()} unit="ACTIVE + COMPLETED" />
          <BigStat
            label="Lifetime GPU-hours"
            value={totalHoursLifetime >= 1000
              ? `${(totalHoursLifetime / 1000).toFixed(1)}k`
              : totalHoursLifetime.toFixed(1)}
            unit="hours metered"
          />
        </div>
      </section>

      {/* Daily Network Revenue */}
      {analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Daily Network Revenue" caption="Last 30 days, sum across all operators" />
            <div className="bg-background border border-foreground/15 p-6">
              <div className="text-foreground">
                <MiniBars values={analytics.dailyRevenue.map(d => d.revenue)} width={1080} height={120} />
              </div>
              <div className="flex items-center justify-between mt-4 font-mono text-xs text-muted-foreground">
                <span>{fmtDay(analytics.dailyRevenue[0]?.date ?? '')}</span>
                <span>
                  30d total: <span className="text-foreground">{fmtUsdShort(analytics.dailyRevenue.reduce((s, d) => s + d.revenue, 0))}</span>
                </span>
                <span>{fmtDay(analytics.dailyRevenue[analytics.dailyRevenue.length - 1]?.date ?? '')}</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 3-Month Projections */}
      {analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader
              eyebrow="3-Month Projections"
              caption={`Based on current run-rate. Growth applied month-over-month from last 30d trajectory (${analytics.projections.monthly.growthPct >= 0 ? '+' : ''}${analytics.projections.monthly.growthPct.toFixed(1)}%).`}
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-foreground/15">
              <ProjectionCard
                label="Daily"
                current={analytics.projections.daily.current}
                projected={analytics.projections.daily.projected}
                growthPct={analytics.projections.daily.growthPct}
              />
              <ProjectionCard
                label="Weekly"
                current={analytics.projections.weekly.current}
                projected={analytics.projections.weekly.projected}
                growthPct={analytics.projections.weekly.growthPct}
              />
              <ProjectionCard
                label="Monthly"
                current={analytics.projections.monthly.current}
                projected={analytics.projections.monthly.projected}
                growthPct={analytics.projections.monthly.growthPct}
              />
            </div>
          </div>
        </section>
      )}

      {/* Monthly Projection Growth */}
      {analytics && analytics.monthlyProjectionGrowth.length > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Monthly Projection Growth" caption="Three months forward, compounded from current trajectory" />
            <div className="bg-background border border-foreground/15 p-6">
              <ul className="grid grid-cols-1 md:grid-cols-3 gap-px bg-foreground/10 -m-6 mt-0">
                {analytics.monthlyProjectionGrowth.map(m => (
                  <li key={m.month} className="bg-background p-6">
                    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
                      Projected, {fmtMonth(m.month)}
                    </p>
                    <p className="font-display text-3xl md:text-4xl text-foreground">
                      {fmtUsdShort(m.projected)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Returns vs Cost */}
      {analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader
              eyebrow="Returns vs Cost"
              caption="Network-wide aggregate. Sum of all operator capital deployed against lifetime earnings."
            />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-foreground/15">
              <BigStat label="Cost basis" value={fmtUsdShort(analytics.returnsVsCost.totalCostBasis)} unit="DEPLOYED" />
              <BigStat label="Lifetime earnings" value={fmtUsdShort(analytics.returnsVsCost.totalEarnings)} unit="RECEIVED" />
              <BigStat
                label="Recoup ratio"
                value={`${(analytics.returnsVsCost.recoupRatio * 100).toFixed(1)}%`}
                unit="EARNINGS / COST"
              />
              <BigStat
                label="Break-even"
                value={analytics.returnsVsCost.breakEvenMonths === null
                  ? '-'
                  : analytics.returnsVsCost.recoupRatio >= 1
                    ? 'reached'
                    : `${analytics.returnsVsCost.breakEvenMonths.toFixed(1)}mo`}
                unit={analytics.returnsVsCost.breakEvenMonths === null ? 'NEED RUN-RATE' : 'AT CURRENT RATE'}
              />
            </div>
          </div>
        </section>
      )}

      {/* Node-Runner Growth + Power User Expansion */}
      {analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-foreground/15">
              <GrowthCard
                eyebrow="Node-Runner Growth"
                caption="Cumulative count, last 90 days"
                value={analytics.noderunnerGrowth[analytics.noderunnerGrowth.length - 1]?.total ?? 0}
                values={analytics.noderunnerGrowth.map(g => g.total)}
              />
              <GrowthCard
                eyebrow="Power User Expansion"
                caption="Weekly count of buyers with >$100 spend, last 12 weeks"
                value={analytics.powerUsers.reduce((s, p) => s + p.count, 0)}
                values={analytics.powerUsers.map(p => p.count)}
                useBars
              />
            </div>
          </div>
        </section>
      )}

      {/* Monthly Financial Performance */}
      {analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Monthly Financial Performance" caption="Revenue, operator payouts, buyer spend - last 6 months" />
            <div className="bg-background border border-foreground/15 overflow-x-auto">
              <table className="w-full font-mono text-sm">
                <thead className="bg-foreground/5">
                  <tr className="text-left text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    <th className="px-4 py-3 font-mono">Month</th>
                    <th className="px-4 py-3 font-mono text-right">Revenue</th>
                    <th className="px-4 py-3 font-mono text-right">Payouts</th>
                    <th className="px-4 py-3 font-mono text-right">Buyer spend</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.monthlyPerformance.map(m => (
                    <tr key={m.month} className="border-t border-foreground/10">
                      <td className="px-4 py-3 text-foreground">{fmtMonth(m.month)}</td>
                      <td className="px-4 py-3 text-right text-foreground">{fmtUsdShort(m.revenue)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{fmtUsdShort(m.payouts)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{fmtUsdShort(m.buyerSpend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Node Rate History */}
      {analytics && Object.keys(analytics.rateHistory).length > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Node Rate History" caption="Median rate per hour, last 60 days, by tier" />
            <div className="bg-background border border-foreground/15 p-6">
              <div className="text-foreground">
                <MultiLine
                  series={Object.entries(analytics.rateHistory).map(([gpuTier, points]) => ({
                    name: gpuTier,
                    values: points.map(p => p.ratePerHour),
                  }))}
                  width={1080}
                  height={200}
                />
              </div>
              <ul className="flex flex-wrap gap-4 mt-4 font-mono text-[11px] text-muted-foreground">
                {Object.entries(analytics.rateHistory).map(([gpuTier], idx) => {
                  const opacity = [1, 0.7, 0.5, 0.35, 0.22][idx] ?? 0.15
                  return (
                    <li key={gpuTier} className="flex items-center gap-2">
                      <span className="block w-4 h-px bg-foreground" style={{ opacity }} />
                      <span>{gpuTier}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Rate Table */}
      {analytics && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto">
            <SectionHeader eyebrow="Rate Table" caption="Current rates and 30-day band per tier" />
            <div className="bg-background border border-foreground/15 overflow-x-auto">
              <table className="w-full font-mono text-sm">
                <thead className="bg-foreground/5">
                  <tr className="text-left text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    <th className="px-4 py-3 font-mono">Tier</th>
                    <th className="px-4 py-3 font-mono text-right">Current $/hr</th>
                    <th className="px-4 py-3 font-mono text-right">30d median</th>
                    <th className="px-4 py-3 font-mono text-right">30d min</th>
                    <th className="px-4 py-3 font-mono text-right">30d max</th>
                    <th className="px-4 py-3 font-mono text-right">30d delta</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.rateTable.map(r => (
                    <tr key={r.gpuTier} className="border-t border-foreground/10">
                      <td className="px-4 py-3 text-foreground">{r.gpuTier}</td>
                      <td className="px-4 py-3 text-right text-foreground">${r.current.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">${r.median30d.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">${r.min30d.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">${r.max30d.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-foreground">
                        {r.deltaPct30d >= 0 ? '+' : ''}{r.deltaPct30d.toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Live Tier Breakdown */}
      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1200px] mx-auto">
          <SectionHeader eyebrow="Live tier breakdown" caption="Online inventory by GPU tier" />
          {data.nodesByTier.length === 0 ? (
            <p className="text-muted-foreground text-sm">No nodes online right now.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-foreground/15">
              {data.nodesByTier.map(t => (
                <div key={t.gpuTier} className="bg-background p-6">
                  <p className="font-display text-4xl md:text-5xl text-foreground">{t.count}</p>
                  <p className="font-mono text-xs text-muted-foreground mt-2">{t.gpuTier}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Region distribution */}
      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1200px] mx-auto">
          <SectionHeader eyebrow="Regional spread" caption="Online inventory by region" />
          {data.regionDistribution.length === 0 ? (
            <p className="text-muted-foreground text-sm">No regional data yet.</p>
          ) : (
            <ul className="space-y-3">
              {data.regionDistribution.map(r => {
                const pct = (r.count / maxRegionCount) * 100
                return (
                  <li key={r.region} className="grid grid-cols-[120px_1fr_60px] md:grid-cols-[180px_1fr_80px] items-center gap-4">
                    <span className="font-mono text-sm text-foreground">{r.region}</span>
                    <span className="block h-2 bg-foreground/10 relative overflow-hidden">
                      <span
                        className="absolute inset-y-0 left-0 bg-foreground"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="font-mono text-sm text-foreground text-right">{r.count}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Reference retail prices */}
      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1200px] mx-auto">
          <SectionHeader eyebrow="Reference retail prices" caption="On-demand $/hr per tier" />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-foreground/15">
            {data.topPricesByTier.map(p => (
              <div key={p.gpuTier} className="bg-background p-6">
                <p className="font-mono text-xs text-muted-foreground mb-2">{p.gpuTier}</p>
                <p className="font-display text-2xl md:text-3xl text-foreground">
                  ${p.ratePerHour.toFixed(2)}
                  <span className="font-mono text-xs text-muted-foreground"> / hr</span>
                </p>
                <p className="font-mono text-[11px] text-muted-foreground mt-1">
                  ${p.ratePerMinute.toFixed(4)} / min
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Carbon line */}
      {data.totalCo2GramsLifetime > 0 && (
        <section className="px-6 lg:px-12 pb-16">
          <div className="max-w-[1200px] mx-auto py-8 border-t border-b border-foreground/10">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
                  Lifetime carbon estimate
                </p>
                <p className="font-display text-3xl md:text-4xl text-foreground">
                  {data.totalCo2GramsLifetime >= 1_000_000
                    ? `${(data.totalCo2GramsLifetime / 1_000_000).toFixed(2)} t CO2`
                    : data.totalCo2GramsLifetime >= 1000
                      ? `${(data.totalCo2GramsLifetime / 1000).toFixed(1)} kg CO2`
                      : `${data.totalCo2GramsLifetime.toFixed(0)} g CO2`}
                </p>
              </div>
              <p className="text-sm text-muted-foreground max-w-md">
                Estimate from GPU TDP times region grid intensity. Honest approximation, never a paid offset claim. Full formula on the buyer billing page.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Feeds */}
      <section className="px-6 lg:px-12 pb-24">
        <div className="max-w-[1200px] mx-auto py-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
            Scrapeable feeds
          </p>
          <p className="text-muted-foreground mb-6 max-w-2xl">
            The full inventory catalog is available as a single JSON document or a CSV. Network analytics is available as JSON too. Use these instead of scraping the HTML.
          </p>
          <div className="flex flex-wrap gap-3 font-mono text-sm">
            <FeedLink href={`${API_URL}/v1/public/listings.json`} label="listings.json" />
            <FeedLink href={`${API_URL}/v1/public/listings.csv`} label="listings.csv" />
            <FeedLink href={`${API_URL}/v1/public/stats`} label="stats.json" />
            <FeedLink href={`${API_URL}/v1/public/network-analytics`} label="network-analytics.json" />
            <FeedLink href={`${API_URL}/docs`} label="OpenAPI spec" />
          </div>
        </div>
      </section>

      <FooterSection />
    </main>
  )
}

// ---------------------------------------------------------------------
// Card subcomponents
// ---------------------------------------------------------------------

function SectionHeader({ eyebrow, caption }: { eyebrow: string; caption: string }) {
  return (
    <div className="mb-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
        {eyebrow}
      </p>
      <p className="font-display text-2xl md:text-3xl text-foreground max-w-2xl leading-tight">
        {caption}
      </p>
    </div>
  )
}

function BigStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="bg-background p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
        {label}
      </p>
      <p className="font-display text-5xl md:text-6xl text-foreground leading-none">
        {value}
      </p>
      <p className="font-mono text-xs text-muted-foreground mt-3">{unit}</p>
    </div>
  )
}

function ProjectionCard({ label, current, projected, growthPct }: {
  label: string; current: number; projected: number; growthPct: number
}) {
  return (
    <div className="bg-background p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
        {label} run-rate
      </p>
      <p className="font-display text-4xl md:text-5xl text-foreground leading-none">
        {fmtUsdShort(current)}
      </p>
      <p className="font-mono text-xs text-muted-foreground mt-3">CURRENT</p>
      <div className="mt-4 pt-4 border-t border-foreground/10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-1">
          Projected
        </p>
        <p className="font-display text-2xl md:text-3xl text-foreground">
          {fmtUsdShort(projected)}
        </p>
        <p className="font-mono text-xs text-muted-foreground mt-1">
          {growthPct >= 0 ? '+' : ''}{growthPct.toFixed(1)}% vs prior 30d
        </p>
      </div>
    </div>
  )
}

function GrowthCard({ eyebrow, caption, value, values, useBars }: {
  eyebrow: string; caption: string; value: number; values: number[]; useBars?: boolean
}) {
  return (
    <div className="bg-background p-8 flex flex-col gap-6 min-h-[260px]">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">
          {eyebrow}
        </p>
        <p className="font-display text-4xl md:text-5xl text-foreground leading-none">
          {value.toLocaleString()}
        </p>
        <p className="font-mono text-xs text-muted-foreground mt-2 max-w-sm">
          {caption}
        </p>
      </div>
      <div className="text-foreground">
        {useBars ? (
          <MiniBars values={values} width={520} height={80} />
        ) : (
          <Sparkline values={values} width={520} height={80} />
        )}
      </div>
    </div>
  )
}

function FeedLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 px-3 py-2 border border-foreground/15 hover:border-foreground hover:bg-foreground/5 transition-colors"
    >
      {label}
      <span aria-hidden>↗</span>
    </Link>
  )
}
