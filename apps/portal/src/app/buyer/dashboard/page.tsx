'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Server,
  Clock,
  DollarSign,
  Loader2,
  Plus,
  Copy,
  Check,
  ArrowRight,
  Activity,
  Wallet,
  Key,
  CreditCard,
  Cpu,
} from 'lucide-react'
import { buyer } from '@/lib/api'
import { A2ELoader } from '@/components/ui/A2ELoader'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
  ClockCard,
  QuickActions,
  ResourceAllocation,
} from '@/components/dashboard/FuturisticShell'

interface BuyerDashboardData {
  activeCompute: number
  pendingRequests: number
  totalSpent: number
  daysRemaining: number
  activeAllocations: {
    id: string
    gpuTier: string
    gpuCount: number
    sshHost?: string
    sshPort?: number
    sshUser?: string
    sshPassword?: string
    expiresAt: string
  }[]
  recentRequests: {
    id: string
    gpuTier: string
    gpuCount: number
    durationDays: number
    totalCost: number
    status: string
    requestedAt: string
  }[]
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING:   { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
  APPROVED:  { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  ALLOCATED: { bg: 'rgba(139,92,246,0.15)', text: '#8b5cf6' },
  ACTIVE:    { bg: 'rgba(34,197,94,0.15)',  text: '#22c55e' },
  COMPLETED: { bg: 'rgba(113,113,122,0.15)', text: '#71717a' },
  CANCELLED: { bg: 'rgba(113,113,122,0.15)', text: '#71717a' },
  REJECTED:  { bg: 'rgba(239,68,68,0.15)',  text: '#ef4444' },
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-2 p-1 rounded transition-colors hover:bg-white/10"
      title="Copy to clipboard"
    >
      {copied
        ? <Check size={14} style={{ color: 'var(--primary)' }} />
        : <Copy size={14} style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

export default function BuyerDashboardPage() {
  const [data, setData] = useState<BuyerDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const d = (await buyer.dashboard()) as BuyerDashboardData
      setData(d)
    } catch {
      /* silently fail */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(() => loadData(), 30_000)
    return () => clearInterval(interval)
  }, [loadData])

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading your dashboard" />
  }

  // Spend "budget" framing for the resource bar: how much of the month
  // has been spent vs. an implied $500 monthly target. Freestyle metric
  // since we do not yet have a user-set budget.
  const monthlyTarget = 500
  const monthSpendPct = Math.min(100, ((data?.totalSpent ?? 0) / monthlyTarget) * 100)

  return (
    <DashboardShell
      title="Compute Dashboard"
      subtitle="Buyer's Portal"
      liveLabel="LIVE"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        {/* Top metrics */}
        <MetricTriad
          metrics={[
            {
              label: 'Active Compute',
              value: `${data?.activeCompute ?? 0}`,
              detail: 'Running rentals',
              icon: Server,
              tone: 'green',
              href: '/buyer/active',
            },
            {
              label: 'Pending Requests',
              value: `${data?.pendingRequests ?? 0}`,
              detail: 'Awaiting allocation',
              icon: Loader2,
              tone: 'orange',
              href: '/buyer/requests',
            },
            {
              label: 'Total Spent',
              value: formatCurrency(data?.totalSpent ?? 0),
              detail: 'Lifetime USDC',
              icon: DollarSign,
              tone: 'cyan',
              href: '/buyer/billing',
            },
          ]}
        />

        {/* Active allocations */}
        {data?.activeAllocations && data.activeAllocations.length > 0 && (
          <SectionCard
            title="Active Compute"
            icon={Activity}
            badge={
              <span className="inline-flex items-center gap-2 px-2 py-0.5 rounded-full border border-accent/40 bg-accent/10">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                <span className="font-mono text-[10px] tracking-[0.14em]" style={{ color: 'var(--primary)' }}>
                  ALLOCATED
                </span>
              </span>
            }
          >
            <div className="space-y-3">
              {data.activeAllocations.map((alloc) => (
                <div
                  key={alloc.id}
                  className="rounded-md border p-4"
                  style={{
                    background: 'rgba(34,197,94,0.04)',
                    borderColor: 'rgba(34,197,94,0.2)',
                  }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="font-mono text-[11px] font-bold px-2 py-0.5 rounded"
                        style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
                      >
                        {alloc.gpuTier}
                      </span>
                      <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                        × {alloc.gpuCount}
                      </span>
                    </div>
                    <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      EXPIRES {new Date(alloc.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  {alloc.sshHost && (
                    <div className="space-y-1.5">
                      <div className="flex items-center text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                        <span style={{ color: 'var(--text-muted)', width: 50 }}>SSH</span>
                        <span>{alloc.sshUser}@{alloc.sshHost}:{alloc.sshPort}</span>
                        <CopyButton text={`ssh ${alloc.sshUser}@${alloc.sshHost} -p ${alloc.sshPort}`} />
                      </div>
                      {alloc.sshPassword && (
                        <div className="flex items-center text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--text-muted)', width: 50 }}>PASS</span>
                          <span>{'•'.repeat(12)}</span>
                          <CopyButton text={alloc.sshPassword} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* Recent Requests */}
        <SectionCard
          title="Recent Requests"
          icon={Cpu}
          actions={
            <Link
              href="/buyer/requests"
              className="inline-flex items-center gap-1 text-xs font-medium transition-colors"
              style={{ color: 'var(--primary)' }}
            >
              View all <ArrowRight size={12} />
            </Link>
          }
        >
          {data?.recentRequests && data.recentRequests.length > 0 ? (
            <div className="space-y-2">
              {data.recentRequests.map((req) => {
                const statusColor = STATUS_COLORS[req.status] ?? STATUS_COLORS.PENDING
                return (
                  <Link key={req.id} href={`/buyer/requests/${req.id}`}>
                    <div
                      className="flex items-center justify-between rounded-md border p-3 transition-colors hover:bg-surface-hover"
                      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-color)' }}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="font-mono text-[11px] font-bold px-2 py-0.5 rounded"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                        >
                          {req.gpuTier}
                        </span>
                        <span className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                          × {req.gpuCount}, {req.durationDays}d
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                          {formatCurrency(req.totalCost)}
                        </span>
                        <span
                          className="font-mono text-[10px] font-bold tracking-[0.1em] px-2 py-0.5 rounded-full"
                          style={{ background: statusColor.bg, color: statusColor.text }}
                        >
                          {req.status}
                        </span>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-8">
              <Server size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No requests yet</p>
              <Link
                href="/buyer/request"
                className="inline-flex items-center gap-1 mt-4 px-4 h-9 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors"
              >
                <Plus size={14} /> Request Compute
              </Link>
            </div>
          )}
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <ClockCard />

        <QuickActions
          actions={[
            { label: 'New Request', href: '/buyer/request', icon: Plus, emphasis: true },
            { label: 'Active',      href: '/buyer/active',  icon: Server },
            { label: 'Billing',     href: '/buyer/billing', icon: CreditCard },
            { label: 'API Keys',    href: '/buyer/api-keys', icon: Key },
          ]}
        />

        <ResourceAllocation
          title="This Month"
          bars={[
            {
              label: 'Spend vs. $500 cap',
              value: monthSpendPct,
              tone: 'green',
              detail: `${formatCurrency(data?.totalSpent ?? 0)} / ${formatCurrency(monthlyTarget)}`,
            },
            {
              label: 'Active rentals',
              value: data?.activeCompute ?? 0,
              max: Math.max(5, (data?.activeCompute ?? 0)),
              tone: 'cyan',
              detail: `${data?.activeCompute ?? 0} live`,
            },
            {
              label: 'Days of compute left',
              value: Math.min(30, data?.daysRemaining ?? 0),
              max: 30,
              tone: 'purple',
              detail: `${data?.daysRemaining ?? 0}d`,
            },
          ]}
        />

        <SectionCard
          title="Wallet"
          icon={Wallet}
          actions={
            <Link
              href="/buyer/billing"
              className="font-mono text-[10px] tracking-[0.14em] uppercase"
              style={{ color: 'var(--text-secondary)' }}
            >
              MANAGE
            </Link>
          }
        >
          <p className="font-mono text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
            Settlement on Solana
          </p>
          <div className="font-display text-2xl tracking-tight" style={{ color: 'var(--text-primary)' }}>
            USDC
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
            Median settlement 11s. Refunds for unused minutes on early termination.
          </p>
        </SectionCard>
      </DashboardRightRail>
    </DashboardShell>
  )
}
