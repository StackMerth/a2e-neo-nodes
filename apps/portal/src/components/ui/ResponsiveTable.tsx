'use client'

import { type ReactNode } from 'react'

interface ResponsiveTableProps {
  children: ReactNode
  className?: string
}

/**
 * Wrapper that makes tables horizontally scrollable on small screens
 * with a subtle fade indicator on the right edge.
 */
export function ResponsiveTable({ children, className = '' }: ResponsiveTableProps) {
  return (
    <div className={`relative ${className}`}>
      <div className="overflow-x-auto -mx-px">
        {children}
      </div>
      {/* Fade indicator for horizontal scroll */}
      <div className="absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-surface to-transparent pointer-events-none md:hidden" />
    </div>
  )
}
