'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Download, History, ArrowLeft } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface EarningRow {
  id: string; nodeId: string; date: string; market: string; earnings: number; gpuSeconds: number; jobCount: number
}

interface HistoryData {
  earnings: EarningRow[]; total: number; page: number; limit: number; pages: number
}

type EarningHistoryRow = EarningRow & Record<string, unknown>

export default function EarningsHistoryPage() {
  const [data, setData] = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const d = await nodeRunner.earningsHistory({ page: String(page), limit: '30' }) as HistoryData
      setData(d)
    } catch { /* ignore */ }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page])

  useEffect(() => { loadData() }, [loadData])

  function exportCSV() {
    if (!data || data.earnings.length === 0) return
    const headers = ['Date', 'Node ID', 'Market', 'Jobs', 'GPU Seconds', 'Earnings (USD)']
    const rows = data.earnings.map(r => [
      new Date(r.date).toLocaleDateString(),
      r.nodeId,
      r.market,
      r.jobCount,
      r.gpuSeconds,
      r.earnings.toFixed(4),
    ])
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `a2e-earnings-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const columns: Array<DataTableColumn<EarningHistoryRow>> = [
    {
      key: 'date',
      header: 'Date',
      render: (r) => new Date(r.date).toLocaleDateString(),
    },
    {
      key: 'market',
      header: 'Market',
      render: (r) => <MarketBadge market={r.market} />,
    },
    {
      key: 'jobCount',
      header: 'Jobs',
      align: 'right',
      mono: true,
      render: (r) => r.jobCount,
    },
    {
      key: 'gpuSeconds',
      header: 'GPU Time',
      align: 'right',
      mono: true,
      render: (r) => `${(r.gpuSeconds / 3600).toFixed(1)}h`,
    },
    {
      key: 'earnings',
      header: 'Earnings',
      align: 'right',
      mono: true,
      render: (r) => `$${r.earnings.toFixed(4)}`,
    },
  ]

  return (
    <DashboardShell
      title="Earnings History"
      subtitle="Full settlement history across all periods"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3 flex flex-col gap-6">
        <Link
          href="/earnings"
          className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] hover:opacity-80 w-fit"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={12} /> Back to Earnings
        </Link>

        <DataTableCard<EarningHistoryRow>
          title="Earnings Records"
          icon={History}
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={exportCSV}
              disabled={!data || data.earnings.length === 0}
            >
              <Download size={14} className="mr-1.5" />
              Export CSV
            </Button>
          }
          columns={columns}
          rows={(data?.earnings ?? []) as EarningHistoryRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={History}
              title="No earnings records"
              description="Earnings entries will appear here as your nodes complete jobs."
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

function MarketBadge({ market }: { market: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    INTERNAL: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' },
    AKASH: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' },
    IONET: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' },
  }
  const s = styles[market] ?? { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}
    >
      {market}
    </span>
  )
}
