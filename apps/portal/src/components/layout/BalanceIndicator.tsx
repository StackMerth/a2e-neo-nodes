'use client'

/**
 * Balance pill in the TopHeader. Context-aware: on /buyer/* routes
 * it shows the buyer's pre-loaded credit balance and links to
 * /buyer/balance; everywhere else it shows the node-runner's
 * withdrawable platform balance and links to /earnings.
 *
 * Auto-hides for users with no relevant role on that surface (e.g.,
 * a pure-buyer visiting a node-runner page would see nothing). Loads
 * once on mount + on path change; refresh by visiting the destination
 * page where the source data lives.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { buyer, nodeRunner } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

type Mode = 'buyer' | 'operator' | null

function resolveMode(pathname: string | null, isBuyer: boolean, isNodeRunner: boolean): Mode {
  if (!pathname) return null
  const onBuyerRoute = pathname.startsWith('/buyer')
  if (onBuyerRoute) {
    return isBuyer ? 'buyer' : null
  }
  // Outside /buyer/* is the node-runner surface. Show operator balance
  // when the user has an operator profile; for pure buyers, fall back
  // to the buyer balance so the pill is still useful.
  if (isNodeRunner) return 'operator'
  if (isBuyer) return 'buyer'
  return null
}

export function BalanceIndicator() {
  const pathname = usePathname()
  const { user } = useAuth()
  const isBuyer = !!user?.isBuyer
  const isNodeRunner = !!user?.isNodeRunner
  const mode = resolveMode(pathname, isBuyer, isNodeRunner)

  const [amount, setAmount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!mode || !user) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    async function load() {
      try {
        if (mode === 'buyer') {
          const r = await buyer.balance.get()
          if (!cancelled) setAmount(r.balanceUsd)
        } else {
          const r = await nodeRunner.payoutMode().catch(() => null)
          if (!cancelled) setAmount(r ? Number(r.available ?? 0) : 0)
        }
      } catch {
        if (!cancelled) setAmount(0)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [mode, user, pathname])

  if (!mode || loading || amount === null) return null

  // Node-runner pill routes to /payouts (not /earnings) so a single
  // click takes the operator straight to the Withdraw flow on the
  // Platform Balance card. /earnings is a reporting view, not the
  // place to act on the balance shown here.
  const href = mode === 'buyer' ? '/buyer/balance' : '/payouts'
  const label = mode === 'buyer' ? 'Balance' : 'Earnings'
  const formatted = amount.toLocaleString(undefined, {
    minimumFractionDigits: amount < 1000 ? 2 : 0,
    maximumFractionDigits: 2,
  })

  return (
    <Link
      href={href}
      className="hidden sm:inline-flex items-center gap-2 h-9 px-3 rounded-md border border-border transition-all hover:opacity-90 shrink-0"
      style={{
        background: 'var(--bg-elevated)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }}
      title={`${label}: $${formatted}`}
    >
      <Wallet size={14} style={{ color: 'var(--primary)' }} />
      <span className="font-mono text-xs uppercase tracking-[0.12em] hidden md:inline" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
        ${formatted}
      </span>
    </Link>
  )
}
