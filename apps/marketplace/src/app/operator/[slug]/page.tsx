/*
 * M3 / D1 (preview): public vanity profile for a node-runner operator.
 *
 * No auth required. Server-rendered with Next.js's `revalidate` cache so a
 * refresh from the API is at most 60s old. Reputation, uptime, region
 * distribution, and recent APPROVED ratings come from the public-operators
 * API route. Visual treatment follows the M5 editorial design system: cream
 * background, Instrument Serif display headings, monospace numerics. No
 * decorative badges; the reputation tier is shown as a small serif word.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Star } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

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
  if (!op) return { title: 'Operator not found' }
  const description = `${op.name} operates ${op.nodes.length} GPU node${op.nodes.length === 1 ? '' : 's'} on the TokenOS DeAI network. Reputation tier ${op.reputationTier.toLowerCase()}.`
  const ogPath = `/og?type=operator&slug=${encodeURIComponent(op.slug)}`
  return {
    title: op.name,
    description,
    openGraph: {
      title: `${op.name} on TokenOS DeAI`,
      description,
      images: [{ url: ogPath, width: 1200, height: 630, alt: `${op.name} operator profile` }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${op.name} on TokenOS DeAI`,
      description,
      images: [ogPath],
    },
  }
}

export default async function OperatorPage({ params }: { params: { slug: string } }) {
  const op = await fetchOperator(params.slug)
  if (!op) notFound()

  const regions = Array.from(new Set(op.nodes.map((n) => n.region).filter(Boolean) as string[]))
  const tierBreakdown = op.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.gpuTier] = (acc[n.gpuTier] || 0) + 1
    return acc
  }, {})
  const tierLabel = op.reputationTier.charAt(0) + op.reputationTier.slice(1).toLowerCase()

  const approvedRatings = op.ratings
  const avgRating = approvedRatings.length > 0
    ? approvedRatings.reduce((s, r) => s + r.score, 0) / approvedRatings.length
    : null

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: op.name,
    url: `https://marketplace.stackforgelab.tech/operator/${op.slug}`,
    description: `GPU compute operator on the TokenOS DeAI network, reputation tier ${tierLabel}, ${op.nodes.length} ${op.nodes.length === 1 ? 'node' : 'nodes'}.`,
    ...(avgRating != null && approvedRatings.length > 0
      ? {
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: avgRating.toFixed(1),
          reviewCount: approvedRatings.length,
          bestRating: 5,
          worstRating: 1,
        },
      }
      : {}),
  }

  return (
    <main className="min-h-screen px-6 py-12 sm:py-16 md:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="max-w-4xl mx-auto space-y-10 sm:space-y-16">
        {/* Breadcrumb */}
        <nav className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">
            Marketplace
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">Operator</span>
        </nav>

        {/* Header */}
        <header className="space-y-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {tierLabel} tier, score {op.reputationScore.toFixed(1)} of 100
          </p>
          <h1 className="font-display text-4xl sm:text-5xl md:text-7xl leading-[1.05] text-foreground">
            {op.name}
          </h1>
          <p className="text-base text-muted-foreground max-w-2xl leading-relaxed">
            {op.totalCompletedJobs.toLocaleString()} completed rentals
            {op.uptimePercent30d != null ? `, ${op.uptimePercent30d.toFixed(1)}% uptime over the last 30 days` : ''}
            {op.availableAsSpot ? ', accepts spot inventory' : ''}.
          </p>
        </header>

        <Separator />

        {/* Stats */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-10">
          <Stat label="Reputation" value={op.reputationScore.toFixed(1)} unit="of 100" />
          <Stat
            label="Uptime 30d"
            value={op.uptimePercent30d != null ? op.uptimePercent30d.toFixed(1) : 'n/a'}
            unit={op.uptimePercent30d != null ? 'percent' : ''}
          />
          <Stat label="GPU nodes" value={String(op.nodes.length)} unit={op.nodes.length === 1 ? 'machine' : 'machines'} />
          <Stat label="Regions" value={String(regions.length)} unit={regions.slice(0, 2).join(', ') || 'unspecified'} />
        </section>

        {/* GPU breakdown */}
        {Object.keys(tierBreakdown).length > 0 && (
          <section className="space-y-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              GPU inventory
            </h2>
            <div className="flex flex-wrap gap-x-8 gap-y-3 font-mono text-base text-foreground">
              {Object.entries(tierBreakdown).map(([tier, count]) => (
                <span key={tier}>
                  <span className="text-foreground">{count}</span>
                  <span className="text-muted-foreground"> × </span>
                  <span className="text-foreground">{tier}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        <Separator />

        {/* Recent ratings */}
        <section className="space-y-6">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Recent buyer ratings
          </h2>
          {op.ratings.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No public ratings yet. Once a rental completes and the rating is moderated, it appears here.
            </p>
          ) : (
            <div className="space-y-6">
              {op.ratings.map((r) => (
                <Card key={r.id} className="shadow-none">
                  <CardHeader className="flex-row items-center justify-between pb-3">
                    <Stars score={r.score} />
                    <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      {new Date(r.createdAt).toLocaleDateString()} · {r.buyerLabel}
                    </span>
                  </CardHeader>
                  {r.comment && (
                    <CardContent className="pt-0">
                      <p className="font-display text-lg leading-relaxed text-foreground">
                        &ldquo;{r.comment}&rdquo;
                      </p>
                    </CardContent>
                  )}
                </Card>
              ))}
            </div>
          )}
        </section>

        <Separator />

        <footer className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground text-center">
          TokenOS DeAI Compute Marketplace · operator profile
        </footer>
      </div>
    </main>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="font-display text-4xl leading-none text-foreground">{value}</p>
      {unit && <p className="font-mono text-xs text-muted-foreground">{unit}</p>}
    </div>
  )
}

function Stars({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={14}
          className={cn(
            n <= score ? 'fill-foreground text-foreground' : 'fill-transparent text-muted-foreground',
          )}
        />
      ))}
    </div>
  )
}
