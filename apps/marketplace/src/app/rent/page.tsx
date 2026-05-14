/*
 * Aggregated GPU rental page. One tile per GPU tier, each showing
 * supply level, architecture + VRAM, a 30-day price sparkline, the
 * current $/hr, and a 30-day price range. Click Rent on any tile
 * opens the auth-or-signup modal; once authenticated the buyer is
 * handed off to user.tokenos.ai with the tier pre-selected.
 *
 * Server-rendered so SEO + metadata work. Data sourced from the same
 * two public endpoints /stats already uses, so the cold-start cache
 * is shared.
 */

import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'
import { RentGrid } from '@/components/rent/rent-grid'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

export const revalidate = 30

export const metadata = {
  title: 'Rent GPUs',
  description: 'Live GPU rental prices on the TokenOS DeAI network. Pick a GPU tier, sign in, and SSH in under a minute.',
  openGraph: {
    title: 'Rent GPUs on TokenOS DeAI',
    description: 'Real-time GPU rental prices across the network. H100, H200, B200, B300, GB300 - billed per minute.',
    images: [{ url: '/og?type=marketplace', width: 1200, height: 630 }],
  },
}

interface StatsResponse {
  totalNodesOnline: number
  nodesByTier: Array<{ gpuTier: string; count: number }>
  topPricesByTier: Array<{ gpuTier: string; ratePerHour: number; ratePerMinute: number }>
}

interface AnalyticsResponse {
  rateHistory: Record<string, Array<{ date: string; ratePerHour: number }>>
  rateTable: Array<{ gpuTier: string; current: number; median30d: number; min30d: number; max30d: number; deltaPct30d: number }>
}

async function fetchStats(): Promise<StatsResponse | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/stats`, { next: { revalidate: 30 } })
    if (!res.ok) return null
    return (await res.json()) as StatsResponse
  } catch { return null }
}

async function fetchAnalytics(): Promise<AnalyticsResponse | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/network-analytics`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    return (await res.json()) as AnalyticsResponse
  } catch { return null }
}

export default async function RentPage() {
  const [stats, analytics] = await Promise.all([fetchStats(), fetchAnalytics()])

  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />

      <section className="pt-24 sm:pt-32 lg:pt-40 pb-10 sm:pb-12 lg:pb-16 px-6 lg:px-12">
        <div className="max-w-[1280px] mx-auto text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <span className="w-8 h-px bg-foreground/30" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Live GPU rental
            </span>
            <span className="w-8 h-px bg-foreground/30" />
          </div>
          <h1 className="font-display text-4xl sm:text-5xl md:text-6xl leading-[0.95] tracking-tight text-foreground mb-4">
            Real-time GPU infrastructure
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Prices set by supply and demand across the TokenOS DeAI network. Transparent. Programmatically queryable. Billed per minute, settled on Solana.
          </p>
        </div>
      </section>

      <section className="px-6 lg:px-12 pb-16">
        <div className="max-w-[1280px] mx-auto">
          {!stats || !analytics ? (
            <p className="font-mono text-sm text-center text-muted-foreground py-12">
              Live prices temporarily unavailable.
            </p>
          ) : (
            <RentGrid stats={stats} analytics={analytics} />
          )}
        </div>
      </section>

      <FooterSection />
    </main>
  )
}
