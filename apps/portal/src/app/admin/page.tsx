'use client'

import { useEffect, useState } from 'react'
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
import { apiFetch } from '@/lib/api'
import { DashboardShell } from '@/components/dashboard/FuturisticShell'
import type { LucideIcon } from 'lucide-react'

interface DashboardStats {
  buyerWithdrawalsPending: number
  operatorWithdrawalsPending: number
  computeRequestsPending: number
  deploymentsPending: number
}

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

const AUTO_REFRESH_MS = 30_000 // 30s — fast enough to feel live, slow enough that 4 admins with the tab open don't hammer the API.

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)

  async function loadStats(showSpinner: boolean) {
    if (showSpinner) setLoading(true)
    try {
      const [buyerW, operatorW, compute, deploy] = await Promise.all([
        apiFetch<{ total: number }>('/v1/admin/buyer-withdrawals?status=PENDING&limit=1').catch(
          () => ({ total: 0 }),
        ),
        apiFetch<{ total: number }>('/v1/admin/withdrawals?status=PENDING&limit=1').catch(
          () => ({ total: 0 }),
        ),
        apiFetch<{ stats: { pending: number } }>('/v1/admin/compute/stats').catch(
          () => ({ stats: { pending: 0 } }),
        ),
        apiFetch<{ deployments: unknown[]; total?: number }>('/v1/admin/deployments?status=PENDING&limit=1').catch(
          () => ({ deployments: [], total: 0 }),
        ),
      ])
      setStats({
        buyerWithdrawalsPending: buyerW.total ?? 0,
        operatorWithdrawalsPending: operatorW.total ?? 0,
        computeRequestsPending: compute.stats?.pending ?? 0,
        deploymentsPending: deploy.total ?? deploy.deployments?.length ?? 0,
      })
      setLastFetched(new Date())
    } catch {
      setStats({
        buyerWithdrawalsPending: 0,
        operatorWithdrawalsPending: 0,
        computeRequestsPending: 0,
        deploymentsPending: 0,
      })
    } finally {
      if (showSpinner) setLoading(false)
    }
  }

  useEffect(() => {
    void loadStats(true)
    const id = setInterval(() => {
      // Skip refresh when the tab is hidden — saves both API roundtrips
      // and the per-admin queue load when nobody's watching.
      if (document.visibilityState !== 'hidden') {
        void loadStats(false)
      }
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const cards: QueueCardProps[] = [
    {
      label: 'Buyer Withdrawals',
      count: stats?.buyerWithdrawalsPending ?? 0,
      icon: ArrowDownToLine,
      href: '/admin/buyer-withdrawals',
      loading,
      accent: 'green',
    },
    {
      label: 'Operator Withdrawals',
      count: stats?.operatorWithdrawalsPending ?? 0,
      icon: ArrowUpToLine,
      href: '/admin/operator-withdrawals',
      loading,
      accent: 'amber',
    },
    {
      label: 'Compute Requests',
      count: stats?.computeRequestsPending ?? 0,
      icon: Cpu,
      href: '/admin/compute',
      loading,
      accent: 'cyan',
    },
    {
      label: 'Deployments',
      count: stats?.deploymentsPending ?? 0,
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
          onClick={() => void loadStats(true)}
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
