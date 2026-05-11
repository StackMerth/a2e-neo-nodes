/*
 * M5.4: sitemap.
 *
 * Static routes: home, marketplace catalog, leaderboard. Then one entry
 * per operator with a public slug, fetched from the leaderboard API
 * (capped at 100 for now; revisit when the operator network exceeds it).
 *
 * Re-generated on each request by Next at runtime; in production this
 * is cached at the Vercel edge layer and refreshed when the catalog
 * data changes upstream.
 */
import type { MetadataRoute } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://marketplace.stackforgelab.tech'
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

interface LeaderboardRow {
  operatorSlug: string
}
interface LeaderboardResponse {
  rows: LeaderboardRow[]
}

async function fetchOperatorSlugs(): Promise<string[]> {
  try {
    const res = await fetch(`${API_URL}/v1/public/leaderboard?tab=reputation&limit=100`, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) return []
    const body = (await res.json()) as LeaderboardResponse
    return body.rows.map(r => r.operatorSlug).filter(Boolean)
  } catch {
    return []
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()
  const slugs = await fetchOperatorSlugs()

  return [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/marketplace`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/leaderboard`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.8,
    },
    ...slugs.map((slug) => ({
      url: `${SITE_URL}/operator/${slug}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.6,
    })),
  ]
}
