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
  /** Defaults to "Rent →"; pages override for variant copy. */
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
          'inline-flex items-center px-3 h-8 rounded-md font-mono text-[11px] uppercase tracking-[0.16em] transition-colors'
        }
        style={
          className
            ? undefined
            : { background: 'var(--brand)', color: '#0a0a0a' }
        }
      >
        {label ?? 'Rent →'}
      </button>
      {open && (
        <RentModal tier={gpuTier} operatorSlug={operatorSlug} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
