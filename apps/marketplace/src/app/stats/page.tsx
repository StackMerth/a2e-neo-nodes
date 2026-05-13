/*
 * Network statistics page. Data fetched server-side so SEO + metadata
 * are preserved; the body renders client-side so Recharts can paint
 * the colorful charts. Navigation + FooterSection wrap the body the
 * same way they do on every other marketplace route, so the menu nav
 * remains visible and the page inherits the marketplace background.
 */

import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'
import {
  ColorfulStats,
  type StatsSnapshot,
  type AnalyticsSnapshot,
} from './_components/colorful-stats'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

export const revalidate = 30

async function fetchStats(): Promise<StatsSnapshot | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/stats`, { next: { revalidate: 30 } })
    if (!res.ok) return null
    return (await res.json()) as StatsSnapshot
  } catch {
    return null
  }
}

async function fetchAnalytics(): Promise<AnalyticsSnapshot | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/network-analytics`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    return (await res.json()) as AnalyticsSnapshot
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

export default async function StatsPage() {
  const [stats, analytics] = await Promise.all([fetchStats(), fetchAnalytics()])
  if (!stats) {
    return (
      <main className="relative min-h-screen overflow-x-hidden noise-overlay">
        <Navigation />
        <section className="pt-32 pb-24 flex items-center justify-center px-6">
          <p className="font-mono text-sm text-muted-foreground">
            Stats temporarily unavailable.
          </p>
        </section>
        <FooterSection />
      </main>
    )
  }
  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />
      <ColorfulStats stats={stats} analytics={analytics} />
      <FooterSection />
    </main>
  )
}
