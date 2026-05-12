/*
 * M5.10: Explorer-style network stats page.
 *
 * Public, server-rendered, 30s revalidate. Animated counters via the
 * `.animate-char-in` utility from globals.css (no chart libs needed
 * for v1; a sparkline pass can land later if the page proves popular).
 *
 * Visual is loyal to the editorial palette: cream, ink, Instrument
 * Serif headlines, JetBrains Mono for numerics and labels. No glow,
 * no decorative badges, no fake bar charts.
 */

import Link from 'next/link'
import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

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

async function fetchStats(): Promise<StatsResponse | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/stats`, { next: { revalidate: 30 } })
    if (!res.ok) return null
    return (await res.json()) as StatsResponse
  } catch {
    return null
  }
}

export const metadata = {
  title: 'Stats',
  description: 'Live network stats for the A2E GPU compute marketplace. Nodes online, operators active, lifetime compute, regional spread.',
  openGraph: {
    title: 'A2E network stats',
    description: 'Live network stats for the A2E GPU compute marketplace.',
    images: [{ url: '/og?type=marketplace', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image' as const,
    images: ['/og?type=marketplace'],
  },
}

export default async function StatsPage() {
  const data = await fetchStats()
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

      <section className="pt-32 lg:pt-40 pb-12 lg:pb-16 px-6 lg:px-12">
        <div className="max-w-[1200px] mx-auto">
          <div className="flex items-center gap-3 mb-8">
            <span className="w-8 h-px bg-foreground/30" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Network stats
            </span>
            <span className="flex-1 h-px bg-foreground/10" />
            <span className="font-mono text-xs text-muted-foreground">
              Updated {new Date(data.timestamp).toLocaleString()}
            </span>
          </div>
          <h1 className="font-display text-5xl md:text-7xl leading-[0.95] tracking-tight text-foreground mb-6 max-w-3xl">
            The numbers, in the open.
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Direct readouts from the database, refreshed every 30 seconds. Nothing here is forecast, projected, or aspirational. If the network shrinks, this page shows it.
          </p>
        </div>
      </section>

      {/* Top-line counters */}
      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-foreground/10">
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

      {/* Tier breakdown */}
      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1200px] mx-auto">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-6">
            Online inventory by GPU tier
          </p>
          {data.nodesByTier.length === 0 ? (
            <p className="text-muted-foreground text-sm">No nodes online right now.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-foreground/10">
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
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-6">
            Regional spread
          </p>
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
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-6">
            Reference retail prices, on-demand
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-foreground/10">
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
            The full inventory catalog is available as a single JSON document or a CSV. Use these instead of scraping the HTML.
          </p>
          <div className="flex flex-wrap gap-3 font-mono text-sm">
            <FeedLink href={`${API_URL}/v1/public/listings.json`} label="listings.json" />
            <FeedLink href={`${API_URL}/v1/public/listings.csv`} label="listings.csv" />
            <FeedLink href={`${API_URL}/v1/public/stats`} label="stats (JSON)" />
            <FeedLink href={`${API_URL}/docs`} label="OpenAPI spec" />
          </div>
        </div>
      </section>

      <FooterSection />
    </main>
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
