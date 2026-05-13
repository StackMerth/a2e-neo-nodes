/*
 * Network statistics page. Data fetched server-side so SEO/metadata
 * is preserved; rendered by the client `<ColorfulStats />` body so
 * Recharts can paint the gradient charts. Page-local dark + colorful
 * aesthetic (override of the editorial cream used elsewhere on the
 * marketplace).
 */

import { ColorfulStats, type StatsSnapshot, type AnalyticsSnapshot } from './_components/colorful-stats'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

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
  description: 'Live network statistics and 3-month projections for the TokenOS DeAI GPU compute marketplace.',
  openGraph: {
    title: 'TokenOS DeAI network statistics',
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
      <main
        className="min-h-screen flex items-center justify-center px-6"
        style={{ background: '#050714', color: '#ffffff' }}
      >
        <p className="font-mono text-sm text-white/55">
          Stats temporarily unavailable.
        </p>
      </main>
    )
  }
  return <ColorfulStats stats={stats} analytics={analytics} />
}
