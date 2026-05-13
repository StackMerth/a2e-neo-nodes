'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Wallet, ExternalLink, CircleCheck, Clock, Loader2, CircleX } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface Payout {
  id: string; nodeId: string; walletAddress: string; amount: number; currency: string
  status: string; periodStart: string; periodEnd: string; jobCount: number
  txHash: string | null; txConfirmed: boolean; createdAt: string; processedAt: string | null
}

interface PayoutData { payouts: Payout[]; total: number; page: number; limit: number; pages: number }

type PayoutRow = Payout & Record<string, unknown>

const statusConfig: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
  COMPLETED: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', icon: <CircleCheck size={12} /> },
  PENDING: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: <Clock size={12} /> },
  PROCESSING: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', icon: <Loader2 size={12} className="animate-spin" /> },
  FAILED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: <CircleX size={12} /> },
}

export default function PayoutsPage() {
  const [data, setData] = useState<PayoutData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try { setData(await nodeRunner.payouts({ page: String(page), limit: '20' }) as PayoutData) }
    catch { /* ignore */ }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page])

  useEffect(() => { loadData() }, [loadData])

  const columns: Array<DataTableColumn<PayoutRow>> = [
    {
      key: 'createdAt',
      header: 'Date',
      render: (p) => new Date(p.createdAt).toLocaleDateString(),
    },
    {
      key: 'periodStart',
      header: 'Period',
      render: (p) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {new Date(p.periodStart).toLocaleDateString()} - {new Date(p.periodEnd).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => {
        const sc = statusConfig[p.status] ?? statusConfig.PENDING!
        return (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            style={{ background: sc.bg, color: sc.color }}
          >
            {sc.icon}
            {p.status}
          </span>
        )
      },
    },
    {
      key: 'jobCount',
      header: 'Jobs',
      align: 'right',
      mono: true,
      render: (p) => p.jobCount,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (p) => `$${p.amount.toFixed(2)}`,
    },
    {
      key: 'txHash',
      header: 'TX',
      align: 'right',
      render: (p) => p.txHash ? (
        <a
          href={`https://solscan.io/tx/${p.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono inline-flex items-center gap-1 hover:opacity-80"
          style={{ color: 'var(--primary)' }}
        >
          {p.txHash.slice(0, 8)}...
          <ExternalLink size={10} />
        </a>
      ) : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>,
    },
  ]

  return (
    <DashboardShell
      title="Payouts"
      subtitle="Settlement and payment history"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3">
        <DataTableCard<PayoutRow>
          title="Payout History"
          icon={Wallet}
          actions={
            <Link href="/payouts/settings">
              <Button variant="secondary" size="sm">
                <Wallet size={14} className="mr-1" />
                Payout Settings
              </Button>
            </Link>
          }
          columns={columns}
          rows={(data?.payouts ?? []) as PayoutRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Wallet}
              title="No payouts yet"
              description="Settlement records will appear here after your first payout cycle."
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
