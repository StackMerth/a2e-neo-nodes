'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { CircleCheck, CircleX, Loader2, Clock, Ban, Zap, Route, Briefcase } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface JobItem {
  id: string
  status: string
  market: string | null
  earnings: number | null
  durationSeconds: number | null
  createdAt: string
  completedAt: string | null
  routingLog: { selectedMarket: string; selectedRate: number; reason: string } | null
}

interface JobsData { jobs: JobItem[]; total: number; page: number; limit: number; pages: number }

type JobRow = JobItem & Record<string, unknown>

const STATUSES = ['', 'COMPLETED', 'FAILED', 'RUNNING', 'PENDING', 'CANCELLED'] as const

const statusIcons: Record<string, React.ReactNode> = {
  COMPLETED: <CircleCheck size={12} />,
  FAILED:    <CircleX size={12} />,
  RUNNING:   <Loader2 size={12} className="animate-spin" />,
  PENDING:   <Clock size={12} />,
  ASSIGNED:  <Zap size={12} />,
  CANCELLED: <Ban size={12} />,
  ROUTING:   <Route size={12} />,
}

const statusStyles: Record<string, { bg: string; color: string }> = {
  COMPLETED: { bg: 'rgba(34,197,94,0.1)',  color: 'var(--success)' },
  FAILED:    { bg: 'rgba(239,68,68,0.1)',  color: 'var(--danger)' },
  RUNNING:   { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' },
  PENDING:   { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' },
  ASSIGNED:  { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' },
  CANCELLED: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' },
  ROUTING:   { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)' },
}

const fmtDuration = (s: number | null) =>
  s == null ? '-' : `${Math.floor(s / 60)}m ${s % 60}s`

export default function JobsPage() {
  const [data, setData] = useState<JobsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const params: Record<string, string> = { page: String(page), limit: '20' }
      if (status) params.status = status
      setData(await nodeRunner.jobs(params) as JobsData)
    } catch { /* ignore */ }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page, status])

  useEffect(() => { loadData() }, [loadData])

  const columns: Array<DataTableColumn<JobRow>> = [
    {
      key: 'id',
      header: 'Job ID',
      mono: true,
      render: (j) => (
        <Link href={`/jobs/${j.id}`} className="hover:underline" style={{ color: 'var(--primary)' }}>
          {j.id.slice(0, 12)}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (j) => {
        const ss = statusStyles[j.status] ?? statusStyles.PENDING!
        return (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            style={{ background: ss.bg, color: ss.color }}
          >
            {statusIcons[j.status] ?? <Clock size={12} />}
            {j.status}
          </span>
        )
      },
    },
    {
      key: 'market',
      header: 'Market',
      render: (j) => j.market ?? '-',
    },
    {
      key: 'durationSeconds',
      header: 'Duration',
      align: 'right',
      mono: true,
      render: (j) => fmtDuration(j.durationSeconds),
    },
    {
      key: 'earnings',
      header: 'Earnings',
      align: 'right',
      mono: true,
      render: (j) => j.earnings != null ? `$${j.earnings.toFixed(4)}` : '-',
    },
    {
      key: 'createdAt',
      header: 'Date',
      align: 'right',
      mono: true,
      render: (j) => new Date(j.createdAt).toLocaleDateString(),
    },
  ]

  // Status filter rendered in the card's actions slot.
  const filterBar = (
    <div className="flex gap-1 flex-wrap">
      {STATUSES.map(s => {
        const isActive = status === s
        return (
          <button
            key={s}
            onClick={() => { setStatus(s); setPage(1) }}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {s || 'All'}
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="Job History"
      subtitle="All jobs executed on your nodes"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3">
        <DataTableCard<JobRow>
          title="Jobs"
          icon={Briefcase}
          actions={filterBar}
          columns={columns}
          rows={(data?.jobs ?? []) as JobRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Briefcase}
              title="No jobs found"
              description={status ? `No ${status.toLowerCase()} jobs yet.` : 'Jobs your nodes complete will appear here.'}
            />
          }
          pagination={data ? {
            page: data.page,
            pageSize: data.limit,
            total: data.total,
            onPageChange: setPage,
          } : undefined}
        />
      </div>
    </DashboardShell>
  )
}
