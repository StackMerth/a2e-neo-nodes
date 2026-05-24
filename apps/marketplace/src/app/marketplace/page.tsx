/*
 * M5.2 / D1: filterable public GPU catalog.
 *
 * Server-rendered. Filters submit via plain GET form so they work
 * without any client JS, and the URL reflects the filter state for free
 * sharing/SEO. ISR with 60s revalidation keeps the page fast while
 * still reasonably fresh against changing inventory.
 *
 * Visual: shares the editorial design system from M5.1 (cream + ink,
 * Instrument Sans/Serif, monospace numerics, sharp corners). No
 * decorative badges; reputation is shown as a small serif word.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'
import { ListingRentButton } from '@/components/rent/listing-rent-button'
import { RentGrid } from '@/components/rent/rent-grid'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

export const revalidate = 60

type ReputationTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM'
type PricingTier = 'ON_DEMAND' | 'SPOT' | 'RESERVED'

interface Listing {
  operatorSlug: string
  operatorName: string
  reputationTier: ReputationTier
  reputationScore: number
  gpuTier: string
  region: string | null
  availableCount: number
  pricingTier: PricingTier
  ratePerHour: number
  ratePerMinute: number
  lastHeartbeat: string
  // C2 wave 2: operator-declared home/residential connection. Optional
  // because older listings won't have it yet.
  isResidential?: boolean
}

interface ListingsResponse {
  total: number
  limit: number
  offset: number
  filters: {
    gpuTier: string | null
    region: string | null
    maxRatePerHour: number | null
    tier: PricingTier
    minReputation: ReputationTier | null
  }
  listings: Listing[]
}

// C2 wave 2: consumer / prosumer tiers slot in after the datacenter
// tiers so the dropdown reads top-down by capability. They're inference-
// only when actually rented, which the request page enforces via the
// workloadType picker.
const GPU_TIERS = ['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'RTX_4090', 'RTX_3090', 'CONSUMER'] as const

// C2 wave 2: tier IDs that the buyer-compute zod refine treats as
// inference-only. Marketplace surfaces this as a small "Inference"
// hint on the row + ensures the rent CTA carries workloadType=
// INFERENCE through to the buyer flow so the user doesn't bounce off
// the locked tier card.
const CONSUMER_TIERS = new Set<string>(['CONSUMER', 'RTX_4090', 'RTX_3090'])

function formatTierLabel(t: string): string {
  if (t === 'RTX_4090') return 'RTX 4090'
  if (t === 'RTX_3090') return 'RTX 3090'
  if (t === 'CONSUMER') return 'Consumer'
  return t
}
const PRICING_TIERS: PricingTier[] = ['ON_DEMAND', 'SPOT', 'RESERVED']
const REP_TIERS: ReputationTier[] = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM']
const REGIONS = ['US-WEST', 'US-EAST', 'EU', 'APAC', 'SA', 'OC']

async function fetchListings(params: URLSearchParams): Promise<ListingsResponse | null> {
  try {
    const url = `${API_URL}/v1/public/listings?${params.toString()}`
    const res = await fetch(url, { next: { revalidate: 60 } })
    if (!res.ok) return null
    return (await res.json()) as ListingsResponse
  } catch {
    return null
  }
}

// Stats + analytics feed the tier-tile grid that lives above the
// listings filter. Same two endpoints the (now-retired) /rent page
// used, so the cold-start cache stays shared.
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

export const metadata = {
  title: 'Marketplace',
  description: 'Browse live GPU inventory across operators. Filter by tier, region, pricing model, and reputation.',
  openGraph: {
    title: 'GPU inventory, live',
    description: 'Browse live GPU inventory across operators. Filter by tier, region, pricing model, and reputation.',
    images: [{ url: '/og?type=marketplace', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image' as const,
    images: ['/og?type=marketplace'],
  },
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  const params = new URLSearchParams()
  for (const key of ['gpuTier', 'region', 'maxRatePerHour', 'tier', 'minReputation']) {
    const v = searchParams[key]
    if (typeof v === 'string' && v.length > 0) params.set(key, v)
  }
  if (!params.has('tier')) params.set('tier', 'ON_DEMAND')

  const [data, stats, analytics] = await Promise.all([
    fetchListings(params),
    fetchStats(),
    fetchAnalytics(),
  ])
  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <p className="font-mono text-sm text-muted-foreground">
          Catalog temporarily unavailable. Try refreshing in a minute.
        </p>
      </main>
    )
  }

  const activeFilters = data.filters
  const totalShown = data.listings.length

  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />

      <section className="pt-24 sm:pt-32 lg:pt-40 pb-10 sm:pb-12 lg:pb-16 px-6 lg:px-12">
        <div className="max-w-[1400px] mx-auto">
          <div className="flex items-center gap-3 mb-6 sm:mb-8">
            <span className="w-8 h-px bg-foreground/30" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Live inventory
            </span>
          </div>
          <h1 className="font-display text-4xl sm:text-5xl md:text-7xl leading-[0.95] tracking-tight text-foreground mb-4 sm:mb-6 max-w-3xl">
            Pick a GPU.
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Quick-rent by tier above, or scroll down to filter the full operator catalog. Per-minute billing, settled on Solana, SSH access in under a minute.
          </p>
        </div>
      </section>

      {/* Tier-tile quick-rent grid. Lives on the marketplace page now
          (was on the separate /rent route, which has been consolidated
          per UX feedback that two pages doing similar jobs created a
          "which one do I click?" moment). */}
      {stats && analytics && (
        <section className="px-6 lg:px-12 pb-10 sm:pb-14 lg:pb-20">
          <div className="max-w-[1400px] mx-auto">
            <div className="flex items-center gap-3 mb-6">
              <span className="w-8 h-px bg-brand" />
              <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Tier overview
              </span>
            </div>
            <RentGrid stats={stats} analytics={analytics} />
          </div>
        </section>
      )}

      <section className="px-6 lg:px-12 pb-16 sm:pb-24">
        <div className="max-w-[1400px] mx-auto">
          <div className="flex items-center gap-3 mb-6 sm:mb-8">
            <span className="w-8 h-px bg-brand" />
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Operator catalog
            </span>
          </div>
        </div>
        <div className="max-w-[1400px] mx-auto grid lg:grid-cols-[280px_1fr] gap-8 lg:gap-12">
          {/* Filter panel: plain GET form, server-rendered. */}
          <aside className="lg:sticky lg:top-32 self-start">
            <form action="/marketplace" method="GET" className="space-y-8">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
                  Filters
                </p>
                <FilterField label="GPU tier" name="gpuTier" value={activeFilters.gpuTier} options={[{ value: '', label: 'Any' }, ...GPU_TIERS.map(t => ({ value: t, label: formatTierLabel(t) }))]} />
                <FilterField label="Region" name="region" value={activeFilters.region} options={[{ value: '', label: 'Any' }, ...REGIONS.map(r => ({ value: r, label: r }))]} />
                <FilterField label="Pricing tier" name="tier" value={activeFilters.tier} options={PRICING_TIERS.map(t => ({ value: t, label: humanTier(t) }))} />
                <FilterField label="Min reputation" name="minReputation" value={activeFilters.minReputation} options={[{ value: '', label: 'Any' }, ...REP_TIERS.map(t => ({ value: t, label: humanRep(t) }))]} />
                <FilterField
                  label="Max $/hr"
                  name="maxRatePerHour"
                  value={activeFilters.maxRatePerHour != null ? String(activeFilters.maxRatePerHour) : null}
                  type="number"
                />
              </div>
              <div className="flex flex-col gap-3">
                <button
                  type="submit"
                  className="w-full bg-foreground text-background h-11 text-sm font-medium hover:bg-foreground/90 transition-colors"
                >
                  Apply filters
                </button>
                <Link
                  href="/marketplace"
                  className="w-full h-11 flex items-center justify-center border border-foreground/20 text-sm font-medium hover:bg-foreground/5 transition-colors"
                >
                  Clear
                </Link>
              </div>
            </form>
          </aside>

          {/* Listings grid */}
          <div>
            <div className="flex items-baseline justify-between mb-6 pb-4 border-b border-foreground/10">
              <p className="font-mono text-sm text-foreground">
                {data.total} {data.total === 1 ? 'listing' : 'listings'}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                Showing {totalShown}, {activeFilters.tier === 'ON_DEMAND' ? 'on-demand' : activeFilters.tier === 'SPOT' ? 'spot (40% off)' : 'reserved (10% off)'} pricing
              </p>
            </div>

            {data.listings.length === 0 ? (
              <div className="py-24 text-center">
                <p className="font-display text-2xl text-foreground mb-4">No matching inventory.</p>
                <p className="text-muted-foreground text-sm">
                  Try loosening the filters, or check back in a minute as inventory shifts.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-foreground/10 border-t border-foreground/10">
                {data.listings.map((l) => (
                  <ListingRow key={`${l.operatorSlug}-${l.gpuTier}-${l.region}`} listing={l} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <FooterSection />
    </main>
  )
}

function FilterField({
  label,
  name,
  value,
  options,
  type,
}: {
  label: string
  name: string
  value: string | null
  options?: { value: string; label: string }[]
  type?: string
}) {
  return (
    <label className="block mb-5">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground block mb-2">
        {label}
      </span>
      {options ? (
        <select
          name={name}
          defaultValue={value ?? ''}
          className="w-full h-10 border border-foreground/15 bg-background px-3 text-sm focus:outline-none focus:border-foreground transition-colors font-mono"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          defaultValue={value ?? ''}
          type={type ?? 'text'}
          step="0.01"
          min="0"
          placeholder="any"
          className="w-full h-10 border border-foreground/15 bg-background px-3 text-sm focus:outline-none focus:border-foreground transition-colors font-mono"
        />
      )}
    </label>
  )
}

function ListingRow({ listing }: { listing: Listing }) {
  return (
    <li>
      <Link
        href={`/operator/${listing.operatorSlug}`}
        className="group block py-6 px-2 hover-lift hover:bg-foreground/[0.015] transition-colors"
      >
        <div className="grid grid-cols-12 gap-4 items-baseline">
          {/* Operator + reputation */}
          <div className="col-span-12 md:col-span-4">
            <p className="font-display text-xl text-foreground">{listing.operatorName}</p>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mt-1">
              {humanRep(listing.reputationTier)}, score {listing.reputationScore}
            </p>
          </div>

          {/* GPU tier + region */}
          <div className="col-span-6 md:col-span-3">
            <p className="font-mono text-base text-foreground">
              {listing.availableCount}
              <span className="text-muted-foreground"> × </span>
              {formatTierLabel(listing.gpuTier)}
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="font-mono text-[11px] text-muted-foreground">
                {listing.region ?? 'region unspecified'}
              </p>
              {CONSUMER_TIERS.has(listing.gpuTier) && (
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/60 border-l border-foreground/15 pl-2">
                  Inference
                </span>
              )}
              {listing.isResidential && (
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/60 border-l border-foreground/15 pl-2"
                  title="Operator-declared home/residential connection. May have lower reliability than datacenter inventory."
                >
                  Home GPU
                </span>
              )}
            </div>
          </div>

          {/* Price */}
          <div className="col-span-6 md:col-span-3 text-right md:text-left">
            <p className="font-display text-2xl text-foreground">
              ${listing.ratePerHour.toFixed(2)}
              <span className="font-mono text-xs text-muted-foreground"> / hr</span>
            </p>
            <p className="font-mono text-[11px] text-muted-foreground mt-1">
              ${listing.ratePerMinute.toFixed(4)} / min
            </p>
          </div>

          {/* CTA - per-row Rent button (M5.10c). Click stops propagation
              so the surrounding row link to /operator/[slug] doesn't
              fire. Buyers who want the profile still click anywhere
              else in the row. The subtle chevron beside Rent is the
              implicit affordance — the whole row is the link, the
              chevron just hints at the row click target. */}
          <div className="col-span-12 md:col-span-2 flex md:justify-end items-center gap-3">
            <ListingRentButton operatorSlug={listing.operatorSlug} gpuTier={listing.gpuTier} />
            <ChevronRight
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className="hidden md:block shrink-0 text-foreground/30 group-hover:text-foreground/70 transition-colors"
            />
          </div>
        </div>
      </Link>
    </li>
  )
}

function humanTier(t: PricingTier): string {
  if (t === 'ON_DEMAND') return 'On-demand'
  if (t === 'SPOT') return 'Spot (40% off)'
  return 'Reserved (10% off)'
}

function humanRep(t: ReputationTier): string {
  return t.charAt(0) + t.slice(1).toLowerCase()
}
