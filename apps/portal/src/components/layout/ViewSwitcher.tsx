'use client'

/*
 * Top-of-sidebar pill that lets a single account flip between the
 * Node Runner surface (/dashboard) and the Buyer surface
 * (/buyer/dashboard). Either link is always reachable now that the
 * role-based redirects in (node-runner)/layout.tsx and buyer/layout
 * .tsx are gone. The active half is highlighted with the brand color.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Server, ShoppingBag } from 'lucide-react'

interface ViewSwitcherProps {
  collapsed: boolean
}

export function ViewSwitcher({ collapsed }: ViewSwitcherProps) {
  const pathname = usePathname()
  const onBuyer = pathname?.startsWith('/buyer') ?? false

  if (collapsed) {
    return (
      <div className="flex flex-col gap-1 px-3 mb-4">
        <Link
          href="/dashboard"
          aria-label="Switch to Node Runner view"
          title="Node Runner"
          className={`flex items-center justify-center h-9 rounded-md transition-colors ${
            !onBuyer ? 'bg-accent text-white' : 'text-text-muted hover:bg-surface-hover'
          }`}
        >
          <Server className="w-4 h-4" />
        </Link>
        <Link
          href="/buyer/dashboard"
          aria-label="Switch to Buyer view"
          title="Buyer"
          className={`flex items-center justify-center h-9 rounded-md transition-colors ${
            onBuyer ? 'bg-accent text-white' : 'text-text-muted hover:bg-surface-hover'
          }`}
        >
          <ShoppingBag className="w-4 h-4" />
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-4 mb-4 p-1 grid grid-cols-2 gap-1 bg-surface-hover rounded-md border border-border">
      <Link
        href="/dashboard"
        className={`flex items-center justify-center gap-2 h-8 rounded text-xs font-medium transition-colors ${
          !onBuyer
            ? 'bg-accent text-white shadow-sm'
            : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <Server className="w-3.5 h-3.5" />
        <span>Node Runner</span>
      </Link>
      <Link
        href="/buyer/dashboard"
        className={`flex items-center justify-center gap-2 h-8 rounded text-xs font-medium transition-colors ${
          onBuyer
            ? 'bg-accent text-white shadow-sm'
            : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <ShoppingBag className="w-3.5 h-3.5" />
        <span>Buyer</span>
      </Link>
    </div>
  )
}
