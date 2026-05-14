'use client'

/*
 * Client island for the operator profile page. Owns the modal state
 * for the per-operator Rent CTA + the per-tier availability grid.
 * The parent page renders all static content; this component drops
 * in two interactive surfaces.
 */

import { useState } from 'react'
import { Cpu, ArrowRight } from 'lucide-react'
import { RentModal } from './rent-grid'

interface TierBreakdownEntry {
  gpuTier: string
  count: number
}

export function OperatorRentCta({
  operatorSlug,
  operatorName,
  defaultTier,
}: {
  operatorSlug: string
  operatorName: string
  /** Tier to preselect when the buyer clicks the big "Rent" CTA. */
  defaultTier: string
}) {
  const [openTier, setOpenTier] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpenTier(defaultTier)}
        className="inline-flex items-center gap-2 px-5 h-11 rounded-md font-mono text-xs uppercase tracking-[0.18em] transition-colors"
        style={{ background: 'var(--brand)', color: '#0a0a0a' }}
      >
        Rent from {operatorName}
        <ArrowRight size={14} />
      </button>
      {openTier && (
        <RentModal tier={openTier} operatorSlug={operatorSlug} onClose={() => setOpenTier(null)} />
      )}
    </>
  )
}

export function OperatorAvailabilityGrid({
  operatorSlug,
  tiers,
}: {
  operatorSlug: string
  tiers: TierBreakdownEntry[]
}) {
  const [openTier, setOpenTier] = useState<string | null>(null)
  if (tiers.length === 0) return null
  return (
    <>
      <section className="space-y-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Current availability
        </h2>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
          Pick a GPU tier this operator runs. The allocator will try their nodes first; if they have no idle capacity at allocation time, the request falls back to the rest of the network.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {tiers.map(t => (
            <button
              key={t.gpuTier}
              type="button"
              onClick={() => setOpenTier(t.gpuTier)}
              className="text-left rounded-xl p-4 bg-card border border-border hover:border-foreground/30 transition-colors group"
            >
              <div className="flex items-start justify-between mb-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {t.count} {t.count === 1 ? 'node' : 'nodes'}
                </span>
                <Cpu size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
              </div>
              <p className="font-display text-2xl text-foreground tracking-tight leading-none">
                {t.gpuTier}
              </p>
              <p className="font-mono text-[11px] text-muted-foreground mt-3 group-hover:text-foreground transition-colors">
                Rent →
              </p>
            </button>
          ))}
        </div>
      </section>
      {openTier && (
        <RentModal tier={openTier} operatorSlug={operatorSlug} onClose={() => setOpenTier(null)} />
      )}
    </>
  )
}
