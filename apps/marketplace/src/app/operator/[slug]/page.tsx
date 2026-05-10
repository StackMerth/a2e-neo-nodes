/**
 * M3 / D1 (preview): public vanity profile for a node-runner operator.
 *
 * No auth required. Server-rendered with Next.js's `revalidate` cache
 * so a refresh from the API is at most 60s old. Fetches reputation,
 * uptime, region distribution, and recent APPROVED ratings from the
 * public-operators API route.
 *
 * The full marketplace browsing experience (filterable catalog +
 * leaderboard + OG cards + SEO) lands in M5. This page is the M3
 * deliverable: one route, one operator at a time.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Star, Server, MapPin, Clock, Shield } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

type ReputationTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'

interface OperatorPublicData {
  id: string
  name: string
  slug: string
  reputationScore: number
  reputationTier: ReputationTier
  availableAsSpot: boolean
  uptimePercent30d: number | null
  totalCompletedJobs: number
  nodes: Array<{ region: string | null; gpuTier: string; status: string }>
  ratings: Array<{
    id: string
    score: number
    comment: string | null
    createdAt: string
    buyerLabel: string
  }>
}

const TIER_COLORS: Record<ReputationTier, { bg: string; text: string; ring: string }> = {
  BRONZE:   { bg: 'rgba(180, 83, 9, 0.15)',   text: '#fb923c', ring: 'rgba(180, 83, 9, 0.4)' },
  SILVER:   { bg: 'rgba(148, 163, 184, 0.15)', text: '#cbd5e1', ring: 'rgba(148, 163, 184, 0.4)' },
  GOLD:     { bg: 'rgba(234, 179, 8, 0.15)',   text: '#facc15', ring: 'rgba(234, 179, 8, 0.4)' },
  PLATINUM: { bg: 'rgba(168, 85, 247, 0.15)',  text: '#c084fc', ring: 'rgba(168, 85, 247, 0.4)' },
}

async function fetchOperator(slug: string): Promise<OperatorPublicData | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/operators/${slug}`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) return null
    return (await res.json()) as OperatorPublicData
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const op = await fetchOperator(params.slug)
  if (!op) return { title: 'Operator not found · A²E' }
  return {
    title: `${op.name} · A²E Operator (${op.reputationTier})`,
    description: `${op.name} operates ${op.nodes.length} GPU node${op.nodes.length === 1 ? '' : 's'} on the A²E network with a ${op.reputationTier} reputation tier.`,
  }
}

export default async function OperatorPage({ params }: { params: { slug: string } }) {
  const op = await fetchOperator(params.slug)
  if (!op) notFound()

  const tier = TIER_COLORS[op.reputationTier]
  const regions = Array.from(new Set(op.nodes.map((n) => n.region).filter(Boolean) as string[]))
  const tierBreakdown = op.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.gpuTier] = (acc[n.gpuTier] || 0) + 1
    return acc
  }, {})

  return (
    <main className="min-h-screen px-6 py-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {op.name}
            </h1>
            <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
              GPU compute operator · A²E network
            </p>
          </div>
          <div
            className="rounded-xl px-5 py-3 flex items-center gap-3"
            style={{ background: tier.bg, border: `1px solid ${tier.ring}` }}
          >
            <Shield size={20} style={{ color: tier.text }} />
            <div>
              <div className="text-xs uppercase tracking-wider" style={{ color: tier.text, opacity: 0.7 }}>
                Reputation
              </div>
              <div className="font-bold" style={{ color: tier.text }}>{op.reputationTier}</div>
            </div>
          </div>
        </header>

        {/* Stats grid */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={<Star size={18} />} label="Reputation Score" value={op.reputationScore.toFixed(1)} sub="out of 100" />
          <StatCard icon={<Clock size={18} />} label="Uptime (30d)" value={op.uptimePercent30d != null ? `${op.uptimePercent30d.toFixed(1)}%` : '—'} sub="last 30 days" />
          <StatCard icon={<Server size={18} />} label="GPU Nodes" value={String(op.nodes.length)} sub={`${tierBreakdown ? Object.keys(tierBreakdown).join(', ') : 'mixed'}`} />
          <StatCard icon={<MapPin size={18} />} label="Regions" value={String(regions.length)} sub={regions.slice(0, 3).join(', ') || 'unspecified'} />
        </section>

        {/* GPU breakdown */}
        {Object.keys(tierBreakdown).length > 0 && (
          <section
            className="rounded-xl p-6"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
              GPU Inventory
            </h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(tierBreakdown).map(([tier, count]) => (
                <span
                  key={tier}
                  className="px-3 py-1.5 rounded-lg text-sm font-mono"
                  style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e' }}
                >
                  {count}× {tier}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Recent ratings */}
        <section
          className="rounded-xl p-6"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
            Recent Buyer Ratings
          </h2>
          {op.ratings.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No public ratings yet. After a buyer's rental completes, their rating appears here once moderated.
            </p>
          ) : (
            <div className="space-y-4">
              {op.ratings.map((r) => (
                <div
                  key={r.id}
                  className="rounded-lg p-4"
                  style={{ background: 'var(--surface-hover)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          size={14}
                          fill={n <= r.score ? '#facc15' : 'transparent'}
                          style={{ color: n <= r.score ? '#facc15' : 'var(--text-muted)' }}
                        />
                      ))}
                    </div>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {new Date(r.createdAt).toLocaleDateString()} · {r.buyerLabel}
                    </span>
                  </div>
                  {r.comment && (
                    <p className="text-sm italic" style={{ color: 'var(--text-secondary)' }}>
                      &ldquo;{r.comment}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="text-center pt-8" style={{ color: 'var(--text-muted)' }}>
          <p className="text-xs">A²E Compute Marketplace · operator profile</p>
        </footer>
      </div>
    </main>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
}) {
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--text-muted)' }}>
        {icon}
        <span className="text-xs uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{sub}</div>
    </div>
  )
}
