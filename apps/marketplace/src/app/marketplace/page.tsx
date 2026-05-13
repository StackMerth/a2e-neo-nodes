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
import { Navigation } from '@/components/landing/navigation'
import { FooterSection } from '@/components/landing/footer-section'
import { cn } from '@/lib/utils'

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

const GPU_TIERS = ['H100', 'H200', 'B200', 'B300', 'GB300'] as const
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

  const data = await fetchListings(params)
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

      <section className="pt-24 sm:pt-32 lg:pt-40 pb-10 sm:pb-16 lg:pb-24 px-6 lg:px-12">
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
            Every row below is an operator with idle nodes ready to allocate. Cheapest first, then higher reputation, then larger availability. Filter on the right; the URL updates so you can share or bookmark the view.
          </p>
        </div>
      </section>

      <section className="px-6 lg:px-12 pb-16 sm:pb-24">
        <div className="max-w-[1400px] mx-auto grid lg:grid-cols-[280px_1fr] gap-8 lg:gap-12">
          {/* Filter panel: plain GET form, server-rendered. */}
          <aside className="lg:sticky lg:top-32 self-start">
            <form action="/marketplace" method="GET" className="space-y-8">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-4">
                  Filters
                </p>
                <FilterField label="GPU tier" name="gpuTier" value={activeFilters.gpuTier} options={[{ value: '', label: 'Any' }, ...GPU_TIERS.map(t => ({ value: t, label: t }))]} />
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
        className="block py-6 px-2 hover-lift hover:bg-foreground/[0.015] transition-colors"
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
              {listing.gpuTier}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground mt-1">
              {listing.region ?? 'region unspecified'}
            </p>
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

          {/* CTA */}
          <div className="col-span-12 md:col-span-2 md:text-right">
            <span className={cn(
              'font-mono text-xs uppercase tracking-[0.18em]',
              'text-foreground/60 hover:text-foreground transition-colors',
            )}>
              View operator →
            </span>
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
