'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { List, Server, ArrowRight } from 'lucide-react'
import { buyer } from '@/lib/api'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

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

type RequestRow = ComputeRequest & Record<string, unknown>

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

  const columns: Array<DataTableColumn<RequestRow>> = [
    {
      key: 'gpuTier',
      header: 'Configuration',
      render: (r) => (
        <Link
          href={`/buyer/requests/${r.id}`}
          className="hover:underline inline-flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
        >
          <Server size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="font-semibold">{r.gpuTier}</span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            x{r.gpuCount} &middot; {r.durationDays}d
          </span>
        </Link>
      ),
    },
    {
      key: 'requestedAt',
      header: 'Requested',
      mono: true,
      render: (r) => new Date(r.requestedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    },
    {
      key: 'totalCost',
      header: 'Total',
      align: 'right',
      mono: true,
      render: (r) => formatCurrency(r.totalCost),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (r) => {
        const sc = STATUS_COLORS[r.status] ?? STATUS_COLORS.PENDING!
        return (
          <span
            className="text-xs font-medium px-2.5 py-1 rounded-full inline-flex items-center gap-1"
            style={{ background: sc.bg, color: sc.text }}
          >
            {r.status}
          </span>
        )
      },
    },
    {
      key: 'id',
      header: '',
      align: 'right',
      width: '40px',
      render: () => <ArrowRight size={14} style={{ color: 'var(--text-muted)' }} />,
    },
  ]

  // Filter pills rendered in the card's actions slot.
  const filterBar = (
    <div className="flex gap-1 flex-wrap">
      {FILTER_OPTIONS.map((opt) => {
        const isActive = filter === opt
        return (
          <button
            key={opt}
            onClick={() => setFilter(opt)}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {opt === 'All' ? 'All' : opt.charAt(0) + opt.slice(1).toLowerCase()}
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="My Requests"
      subtitle="Compute rentals you've submitted"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3">
        <DataTableCard<RequestRow>
          title="Requests"
          icon={List}
          actions={filterBar}
          columns={columns}
          rows={(requests ?? []) as RequestRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Server}
              title="No requests found"
              description={filter !== 'All'
                ? `No ${filter.toLowerCase()} requests. Try a different filter.`
                : 'Submit your first compute request to get started.'}
              action={filter === 'All' ? (
                <Link
                  href="/buyer/request"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium"
                  style={{ background: 'var(--primary)', color: '#fff' }}
                >
                  Request Compute
                </Link>
              ) : undefined}
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
