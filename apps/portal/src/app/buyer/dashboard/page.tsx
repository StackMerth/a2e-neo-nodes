'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  LayoutDashboard,
  Server,
  Clock,
  DollarSign,
  Loader2,
  RefreshCw,
  Plus,
  Copy,
  Check,
  ArrowRight,
} from 'lucide-react'
import { buyer } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'

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
    createdAt: string
  }[]
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
  },
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
  APPROVED: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  ALLOCATED: { bg: 'rgba(139,92,246,0.15)', text: '#8b5cf6' },
  ACTIVE: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  COMPLETED: { bg: 'rgba(113,113,122,0.15)', text: '#71717a' },
  CANCELLED: { bg: 'rgba(113,113,122,0.15)', text: '#71717a' },
  REJECTED: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
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
      {copied ? <Check size={14} style={{ color: 'var(--primary)' }} /> : <Copy size={14} style={{ color: 'var(--text-muted)' }} />}
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
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-14 w-full" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-60 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    )
  }

  const stats = [
    {
      label: 'Active Compute',
      value: `${data?.activeCompute ?? 0}`,
      icon: <Server size={18} />,
      colorClass: 'green',
    },
    {
      label: 'Pending Requests',
      value: `${data?.pendingRequests ?? 0}`,
      icon: <Loader2 size={18} />,
      colorClass: 'orange',
    },
    {
      label: 'Total Spent',
      value: formatCurrency(data?.totalSpent ?? 0),
      icon: <DollarSign size={18} />,
      colorClass: 'blue',
    },
    {
      label: 'Days Remaining',
      value: `${data?.daysRemaining ?? 0}`,
      icon: <Clock size={18} />,
      colorClass: 'purple',
    },
  ]

  return (
    <motion.div
      className="dashboard-modern"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.div className="dash-header" variants={itemVariants}>
        <div className="dash-header-left">
          <h1><LayoutDashboard size={28} /> Compute Dashboard</h1>
        </div>
        <div className="dash-header-right">
          <div className="dash-date-badge">
            <Clock size={14} />
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          <button
            className="dash-refresh-btn"
            onClick={() => loadData(true)}
            disabled={refreshing}
            title="Refresh data"
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </motion.div>

      {/* Stat Blocks */}
      <motion.div className="stat-blocks" variants={containerVariants}>
        {stats.map((s) => (
          <motion.div
            key={s.label}
            className={`stat-block ${s.colorClass}`}
            variants={itemVariants}
          >
            <div className="stat-icon">{s.icon}</div>
            <div className="stat-content">
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Active Compute Cards */}
      {data?.activeAllocations && data.activeAllocations.length > 0 && (
        <motion.div variants={itemVariants}>
          <div className="dash-chart-card">
            <h3 className="dash-chart-title">Active Compute</h3>
            <div className="space-y-4">
              {data.activeAllocations.map((alloc) => (
                <div
                  key={alloc.id}
                  className="rounded-xl p-4"
                  style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs font-bold px-2.5 py-1 rounded-md"
                        style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
                      >
                        {alloc.gpuTier}
                      </span>
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        x{alloc.gpuCount}
                      </span>
                    </div>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Expires {new Date(alloc.expiresAt).toLocaleDateString()}
                    </span>
                  </div>
                  {alloc.sshHost && (
                    <div className="space-y-1.5">
                      <div className="flex items-center text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                        <span style={{ color: 'var(--text-muted)', width: 60 }}>SSH:</span>
                        <span>{alloc.sshUser}@{alloc.sshHost}:{alloc.sshPort}</span>
                        <CopyButton text={`ssh ${alloc.sshUser}@${alloc.sshHost} -p ${alloc.sshPort}`} />
                      </div>
                      {alloc.sshPassword && (
                        <div className="flex items-center text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                          <span style={{ color: 'var(--text-muted)', width: 60 }}>Pass:</span>
                          <span>{'*'.repeat(12)}</span>
                          <CopyButton text={alloc.sshPassword} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* Recent Requests */}
      <motion.div variants={itemVariants}>
        <div className="dash-chart-card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="dash-chart-title" style={{ marginBottom: 0 }}>Recent Requests</h3>
            <Link href="/buyer/requests">
              <button
                className="flex items-center gap-1 text-xs font-medium transition-colors"
                style={{ color: 'var(--primary)' }}
              >
                View All <ArrowRight size={14} />
              </button>
            </Link>
          </div>
          {data?.recentRequests && data.recentRequests.length > 0 ? (
            <div className="space-y-2">
              {data.recentRequests.map((req) => {
                const statusColor = STATUS_COLORS[req.status] ?? STATUS_COLORS.PENDING
                return (
                  <Link key={req.id} href={`/buyer/requests/${req.id}`}>
                    <div
                      className="flex items-center justify-between rounded-lg p-3 transition-colors"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="text-xs font-bold px-2 py-0.5 rounded"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                        >
                          {req.gpuTier}
                        </span>
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          x{req.gpuCount} &middot; {req.durationDays}d
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {formatCurrency(req.totalCost)}
                        </span>
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full"
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
              <Server size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 8px' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No requests yet</p>
              <Link href="/buyer/request">
                <button className="btn btn-primary mt-4" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Plus size={16} /> Request Compute
                </button>
              </Link>
            </div>
          )}
        </div>
      </motion.div>

      {/* Quick Actions */}
      <motion.div variants={itemVariants}>
        <div className="dash-chart-card">
          <h3 className="dash-chart-title">Quick Actions</h3>
          <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <Link href="/buyer/request">
              <button className="btn btn-primary">
                <Plus size={16} />
                Request Compute
              </button>
            </Link>
            <Link href="/buyer/active">
              <button className="btn btn-secondary">
                <Server size={16} />
                View Active
              </button>
            </Link>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
