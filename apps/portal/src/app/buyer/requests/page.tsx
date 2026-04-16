'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { List, Server, RefreshCw, ArrowRight } from 'lucide-react'
import { buyer } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'

interface ComputeRequest {
  id: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  totalCost: number
  status: string
  purpose?: string
  requestedAt: string
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b' },
  APPROVED: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  ALLOCATED: { bg: 'rgba(139,92,246,0.15)', text: '#8b5cf6' },
  ACTIVE: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  COMPLETED: { bg: 'rgba(113,113,122,0.15)', text: '#71717a' },
  CANCELLED: { bg: 'rgba(113,113,122,0.15)', text: '#71717a' },
  REJECTED: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
}

const FILTER_OPTIONS = ['All', 'PENDING', 'ACTIVE', 'COMPLETED'] as const
type FilterOption = typeof FILTER_OPTIONS[number]

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

export default function RequestsListPage() {
  const [requests, setRequests] = useState<ComputeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<FilterOption>('All')

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const params: Record<string, string> = {}
      if (filter !== 'All') params.status = filter
      const data = (await buyer.requests(Object.keys(params).length ? params : undefined)) as { requests: ComputeRequest[] }
      setRequests(data.requests ?? [])
    } catch {
      /* silently fail */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [filter])

  useEffect(() => {
    setLoading(true)
    loadData()
  }, [loadData])

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-12 w-80" />
        {[1, 2, 3, 4].map(i => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    )
  }

  return (
    <motion.div
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.div className="dash-header" variants={itemVariants}>
        <div className="dash-header-left">
          <h1><List size={28} /> My Requests</h1>
        </div>
        <div className="dash-header-right">
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

      {/* Filter Pills */}
      <motion.div variants={itemVariants}>
        <div style={{ display: 'flex', gap: '4px', padding: '4px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)', width: 'fit-content' }}>
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className="px-4 py-1.5 rounded-md text-xs font-medium transition-all"
              style={{
                background: filter === opt ? 'var(--primary)' : 'transparent',
                color: filter === opt ? '#fff' : 'var(--text-muted)',
              }}
            >
              {opt === 'All' ? 'All' : opt.charAt(0) + opt.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </motion.div>

      {/* Request Cards */}
      {requests.length > 0 ? (
        <motion.div className="space-y-3" variants={containerVariants}>
          {requests.map((req) => {
            const statusColor = STATUS_COLORS[req.status] ?? STATUS_COLORS.PENDING
            return (
              <motion.div key={req.id} variants={itemVariants}>
                <Link href={`/buyer/requests/${req.id}`}>
                  <div
                    className="rounded-xl p-4 transition-all duration-200 hover:border-white/20"
                    style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Server size={18} style={{ color: 'var(--text-muted)' }} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                              {req.gpuTier}
                            </span>
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              x{req.gpuCount} &middot; {req.durationDays} days
                            </span>
                          </div>
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {new Date(req.requestedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {formatCurrency(req.totalCost)}
                        </span>
                        <span
                          className="text-xs font-medium px-2.5 py-1 rounded-full"
                          style={{ background: statusColor.bg, color: statusColor.text }}
                        >
                          {req.status}
                        </span>
                        <ArrowRight size={16} style={{ color: 'var(--text-muted)' }} />
                      </div>
                    </div>
                  </div>
                </Link>
              </motion.div>
            )
          })}
        </motion.div>
      ) : (
        <motion.div variants={itemVariants}>
          <div
            className="rounded-xl p-12 text-center"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <Server size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              No requests found
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {filter !== 'All' ? `No ${filter.toLowerCase()} requests. Try a different filter.` : 'Submit your first compute request to get started.'}
            </p>
            {filter === 'All' && (
              <Link href="/buyer/request">
                <button className="btn btn-primary mt-4" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  Request Compute
                </button>
              </Link>
            )}
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}
