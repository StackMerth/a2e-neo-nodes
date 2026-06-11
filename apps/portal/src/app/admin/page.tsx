'use client'

import Link from 'next/link'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Cpu,
  Server,
  Loader2,
  TrendingUp,
  RefreshCw,
} from 'lucide-react'
import { DashboardShell } from '@/components/dashboard/FuturisticShell'
import type { LucideIcon } from 'lucide-react'
import { useAdminPendingCounts } from '@/components/layout/AdminPendingCountsContext'

interface QueueCardProps {
  label: string
  count: number
  icon: LucideIcon
  href: string
  loading: boolean
  accent: 'green' | 'amber' | 'cyan' | 'violet'
}

const ACCENTS = {
  green: { bg: 'rgba(34, 197, 94, 0.12)', text: '#22c55e' },
  amber: { bg: 'rgba(245, 158, 11, 0.12)', text: '#f59e0b' },
  cyan: { bg: 'rgba(6, 182, 212, 0.12)', text: '#06b6d4' },
  violet: { bg: 'rgba(139, 92, 246, 0.12)', text: '#8b5cf6' },
} as const

function QueueCard({ label, count, icon: Icon, href, loading, accent }: QueueCardProps) {
  const tint = ACCENTS[accent]
  return (
    <Link
      href={href}
      className="block rounded-xl p-5 transition-transform hover:translate-y-[-2px]"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
      }}
    >
      <div className="flex items-start justify-between">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ background: tint.bg }}
        >
          <Icon size={20} className="shrink-0" />
        </div>
        {loading ? (
          <Loader2 size={16} className="animate-spin opacity-60" />
        ) : (
          <span
            className="text-3xl font-mono font-semibold"
            style={{ color: count > 0 ? tint.text : 'var(--text-secondary)' }}
          >
            {count}
          </span>
        )}
      </div>
      <div className="mt-3">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        <div className="text-2xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
          {count > 0 ? 'Awaiting your review' : 'All caught up'}
        </div>
      </div>
    </Link>
  )
}

const AUTO_REFRESH_MS = 30_000

export default function AdminDashboardPage() {
  const { counts, loading, lastFetched, refresh } = useAdminPendingCounts()

  const cards: QueueCardProps[] = [
    {
      label: 'Buyer Withdrawals',
      count: counts.buyerWithdrawals,
      icon: ArrowDownToLine,
      href: '/admin/buyer-withdrawals',
      loading,
      accent: 'green',
    },
    {
      label: 'Operator Withdrawals',
      count: counts.operatorWithdrawals,
      icon: ArrowUpToLine,
      href: '/admin/operator-withdrawals',
      loading,
      accent: 'amber',
    },
    {
      label: 'Compute Requests',
      count: counts.compute,
      icon: Cpu,
      href: '/admin/compute',
      loading,
      accent: 'cyan',
    },
    {
      label: 'Deployments',
      count: counts.deployments,
      icon: Server,
      href: '/admin/deployments',
      loading,
      accent: 'violet',
    },
  ]

  return (
    <DashboardShell
      title="Admin Dashboard"
      subtitle="Review queues across the platform"
    >
      <div className="lg:col-span-3 flex items-center justify-between mb-3">
        <div className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
          {lastFetched
            ? `Updated ${Math.floor((Date.now() - lastFetched.getTime()) / 1000)}s ago · auto-refresh every ${AUTO_REFRESH_MS / 1000}s`
            : 'Loading…'}
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="text-xs inline-flex items-center gap-1.5 px-2.5 py-1 rounded transition-colors disabled:opacity-50"
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-color)',
          }}
          title="Refresh now"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="lg:col-span-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <QueueCard key={c.label} {...c} />
        ))}
      </div>

      <div className="lg:col-span-3 mt-6">
        <div
          className="rounded-xl p-5 flex items-start gap-4"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
          }}
        >
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'rgba(34, 197, 94, 0.12)', color: 'var(--primary)' }}
          >
            <TrendingUp size={20} />
          </div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
              Working notes
            </div>
            All admin actions take effect immediately. Approve / reject is
            irreversible (rejections refund automatically; approvals broadcast
            on-chain). When in doubt, leave the row in queue and check the
            buyer&apos;s history first.
          </div>
        </div>
      </div>
    </DashboardShell>
  )
}
