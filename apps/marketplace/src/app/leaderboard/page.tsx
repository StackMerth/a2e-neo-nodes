/*
 * M5.3 / D1: public operator leaderboard.
 *
 * Two tabs:
 *   - Reputation (default): top operators by reputationScore
 *   - Referrers: empty placeholder until M5.7 (D2 referral program) wires up
 *
 * Tab state is a single ?tab= query param so the URL is shareable and
 * the page stays server-rendered. No client JS required.
 */

import Link from 'next/link'
import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'
import { cn } from '@/lib/utils'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'

export const revalidate = 60

type ReputationTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'

interface ReputationRow {
  rank: number
  operatorSlug: string
  operatorName: string
  reputationTier: ReputationTier
  reputationScore: number
  totalCompletedJobs: number
  totalNodes: number
}

interface ReferrerRow {
  rank: number
  operatorSlug: string
  operatorName: string
  refereeCount: number
  lifetimeCommission: number
}

interface ReputationResponse {
  tab: 'reputation'
  limit: number
  total: number
  rows: ReputationRow[]
}

interface ReferrersResponse {
  tab: 'referrers'
  limit: number
  total: number
  rows: ReferrerRow[]
  notice?: string
}

async function fetchLeaderboard(tab: string): Promise<ReputationResponse | ReferrersResponse | null> {
  try {
    const res = await fetch(`${API_URL}/v1/public/leaderboard?tab=${tab}&limit=50`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) return null
    return (await res.json()) as ReputationResponse | ReferrersResponse
  } catch {
    return null
  }
}

export const metadata = {
  title: 'Leaderboard',
  description: 'Top operators on the TokenOS DeAI network ranked by transparent reputation score.',
  openGraph: {
    title: 'Earned, not bought',
    description: 'Operators ranked by uptime, ratings, and completed jobs. Formula is public.',
    images: [{ url: '/og?type=leaderboard', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image' as const,
    images: ['/og?type=leaderboard'],
  },
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  const tabRaw = typeof searchParams.tab === 'string' ? searchParams.tab : 'reputation'
  const tab = tabRaw === 'referrers' ? 'referrers' : 'reputation'

  const data = await fetchLeaderboard(tab)
  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <p className="font-mono text-sm text-muted-foreground">
          Leaderboard temporarily unavailable.
        </p>
      </main>
    )
  }

  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />

      <section className="pt-32 lg:pt-40 pb-12 lg:pb-16 px-6 lg:px-12">
        <div className="max-w-[1200px] mx-auto">
          <div className="flex items-center gap-3 mb-8">
            <span className="w-8 h-px bg-foreground/30" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Leaderboard
            </span>
          </div>
          <h1 className="font-display text-5xl md:text-7xl leading-[0.95] tracking-tight text-foreground mb-6 max-w-3xl">
            Earned, not bought.
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Reputation is 60 percent uptime, 25 percent buyer ratings, 15 percent completed-job volume. The formula is public, the ranks are public, the math is public.
          </p>
        </div>
      </section>

      <section className="px-6 lg:px-12 pb-24">
        <div className="max-w-[1200px] mx-auto">
          {/* Tabs */}
          <div className="flex items-center gap-8 border-b border-foreground/10 mb-10">
            <TabLink href="/leaderboard?tab=reputation" active={tab === 'reputation'} label="Reputation" />
            <TabLink href="/leaderboard?tab=referrers" active={tab === 'referrers'} label="Top referrers" />
          </div>

          {tab === 'reputation' ? (
            <ReputationTable data={data as ReputationResponse} />
          ) : (
            <ReferrersTable data={data as ReferrersResponse} />
          )}
        </div>
      </section>

      <FooterSection />
    </main>
  )
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        'relative pb-4 font-display text-xl transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {active && <span className="absolute -bottom-px left-0 right-0 h-px bg-foreground" />}
    </Link>
  )
}

function ReputationTable({ data }: { data: ReputationResponse }) {
  if (data.rows.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="font-display text-2xl text-foreground mb-4">No operators yet.</p>
        <p className="text-muted-foreground text-sm">
          Operators appear here once they have a reputation score above zero.
        </p>
      </div>
    )
  }

  return (
    <div>
      {/* Header row */}
      <div className="grid grid-cols-12 gap-4 pb-4 border-b border-foreground/10 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <div className="col-span-1">Rank</div>
        <div className="col-span-5">Operator</div>
        <div className="col-span-2 text-right md:text-left">Tier</div>
        <div className="col-span-2 text-right md:text-left">Score</div>
        <div className="col-span-2 text-right">Volume</div>
      </div>

      <ul className="divide-y divide-foreground/10">
        {data.rows.map((r) => (
          <li key={r.operatorSlug}>
            <Link
              href={`/operator/${r.operatorSlug}`}
              className="grid grid-cols-12 gap-4 items-baseline py-5 px-2 hover-lift hover:bg-foreground/[0.015] transition-colors"
            >
              <div className="col-span-1 font-mono text-base text-muted-foreground">
                {String(r.rank).padStart(2, '0')}
              </div>
              <div className="col-span-5">
                <p className="font-display text-xl text-foreground">{r.operatorName}</p>
                <p className="font-mono text-[11px] text-muted-foreground mt-1">
                  {r.totalNodes} {r.totalNodes === 1 ? 'node' : 'nodes'}
                </p>
              </div>
              <div className="col-span-2 text-right md:text-left font-mono text-sm text-foreground">
                {humanRep(r.reputationTier)}
              </div>
              <div className="col-span-2 text-right md:text-left">
                <p className="font-display text-2xl text-foreground">
                  {r.reputationScore.toFixed(1)}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">of 100</p>
              </div>
              <div className="col-span-2 text-right">
                <p className="font-mono text-base text-foreground">
                  {r.totalCompletedJobs.toLocaleString()}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">jobs done</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReferrersTable({ data }: { data: ReferrersResponse }) {
  if (data.rows.length === 0) {
    return (
      <div className="py-24 text-center max-w-xl mx-auto">
        <p className="font-display text-3xl text-foreground mb-4">No referrers yet.</p>
        <p className="text-muted-foreground leading-relaxed">
          {data.notice ?? 'Operators earn 10 percent of their referees first 365 days of network earnings. The first referrer who accrues commission lands here.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      {/* Header row */}
      <div className="grid grid-cols-12 gap-4 pb-4 border-b border-foreground/10 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <div className="col-span-1">Rank</div>
        <div className="col-span-6">Operator</div>
        <div className="col-span-2 text-right md:text-left">Referees</div>
        <div className="col-span-3 text-right">Lifetime commission</div>
      </div>

      <ul className="divide-y divide-foreground/10">
        {data.rows.map((r) => (
          <li key={r.operatorSlug}>
            <Link
              href={`/operator/${r.operatorSlug}`}
              className="grid grid-cols-12 gap-4 items-baseline py-5 px-2 hover-lift hover:bg-foreground/[0.015] transition-colors"
            >
              <div className="col-span-1 font-mono text-base text-muted-foreground">
                {String(r.rank).padStart(2, '0')}
              </div>
              <div className="col-span-6">
                <p className="font-display text-xl text-foreground">{r.operatorName}</p>
                <p className="font-mono text-[11px] text-muted-foreground mt-1">
                  /operator/{r.operatorSlug}
                </p>
              </div>
              <div className="col-span-2 text-right md:text-left">
                <p className="font-mono text-base text-foreground">{r.refereeCount}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {r.refereeCount === 1 ? 'operator' : 'operators'}
                </p>
              </div>
              <div className="col-span-3 text-right">
                <p className="font-display text-2xl text-foreground">
                  ${r.lifetimeCommission.toFixed(2)}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">accrued</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function humanRep(t: ReputationTier): string {
  return t.charAt(0) + t.slice(1).toLowerCase()
}
