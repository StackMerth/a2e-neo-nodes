'use client'

/*
 * Small client island used by the per-operator catalog and leader-
 * board rows. Renders a Rent button that, on click, opens the auth
 * modal with both the GPU tier and the operator slug pre-set.
 *
 * Stopping click propagation matters here: in both surfaces the
 * outer row is a Link to /operator/[slug]. Without the stopPropagation
 * the click would also navigate to the profile page.
 */

import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { RentModal } from './rent-grid'

export function ListingRentButton({
  operatorSlug,
  gpuTier,
  className,
  label,
}: {
  operatorSlug: string
  gpuTier: string
  className?: string
  /** Defaults to "Rent"; pages override for variant copy. */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className={
          className ??
          // Editorial proportions: taller, sharper, more horizontal
          // breathing room. The arrow uses Lucide so its weight matches
          // the rest of the marketplace iconography (vs. the previous
          // ASCII '→' which rendered noticeably lighter than the text).
          'group inline-flex items-center gap-2 px-5 h-10 rounded-sm font-mono text-[11px] uppercase tracking-[0.18em] transition-all hover:brightness-105 hover:gap-2.5'
        }
        style={
          className
            ? undefined
            : { background: 'var(--brand)', color: '#0a0a0a' }
        }
      >
        <span>{label ?? 'Rent'}</span>
        <ArrowRight
          size={14}
          strokeWidth={2.25}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </button>
      {open && (
        <RentModal tier={gpuTier} operatorSlug={operatorSlug} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
