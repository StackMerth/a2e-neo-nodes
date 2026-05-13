'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { TrendingUp, BarChart3, CalendarDays, ArrowDownToLine, Briefcase, History } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { getMarketColor } from '@/lib/market-colors'
import { Button } from '@/components/ui/Button'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  MetricTriad,
  SectionCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

interface EarningRow {
  id: string
  nodeId: string
  date: string
  market: string
  earnings: number
  jobCount: number
}

interface EarningsData {
  earnings: EarningRow[]
  total: number
  byMarket: Record<string, number>
  byNode: Record<string, number>
}

type EarningTableRow = EarningRow & Record<string, unknown>

type Period = 'day' | 'week' | 'month' | 'all'

const PERIOD_LABELS: Record<Period, string> = {
  day: 'Today',
  week: 'This Week',
  month: 'This Month',
  all: 'All Time',
}

export default function EarningsPage() {
  const [data, setData] = useState<EarningsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [withdrawalBalance, setWithdrawalBalance] = useState<number | null>(null)

  useEffect(() => { loadData() }, [period])

  useEffect(() => {
    nodeRunner.withdrawalBalance()
      .then((res) => setWithdrawalBalance((res as { available: number }).available ?? 0))
      .catch(() => { /* ignore */ })
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const d = await nodeRunner.earnings(period) as EarningsData
      setData(d)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const total = data?.total ?? 0
  const jobCount = data?.earnings.reduce((sum, e) => sum + (e.jobCount ?? 0), 0) ?? 0
  const marketCount = Object.keys(data?.byMarket ?? {}).length

  const metrics: MetricCardData[] = [
    {
      label: `Earnings - ${PERIOD_LABELS[period]}`,
      value: `$${total.toFixed(2)}`,
      detail: withdrawalBalance !== null ? `Available to withdraw: $${withdrawalBalance.toFixed(2)}` : 'GPU compute earnings',
      icon: TrendingUp,
      tone: 'green',
    },
    {
      label: 'Jobs in period',
      value: jobCount,
      detail: `${data?.earnings.length ?? 0} earnings records`,
      icon: Briefcase,
      tone: 'blue',
    },
    {
      label: 'Markets',
      value: marketCount,
      detail: marketCount > 0 ? `${Object.keys(data?.byMarket ?? {}).join(', ')}` : 'No earnings yet',
      icon: BarChart3,
      tone: 'purple',
    },
  ]

  const columns: Array<DataTableColumn<EarningTableRow>> = [
    {
      key: 'date',
      header: 'Date',
      render: (r) => new Date(r.date).toLocaleDateString(),
    },
    {
      key: 'market',
      header: 'Market',
      render: (r) => {
        const c = getMarketColor(r.market)
        return (
          <span
            className="text-xs font-semibold px-2.5 py-0.5 rounded-full"
            style={{ background: c.bg, color: c.text }}
          >
            {r.market}
          </span>
        )
      },
    },
    {
      key: 'jobCount',
      header: 'Jobs',
      align: 'right',
      mono: true,
      render: (r) => r.jobCount,
    },
    {
      key: 'earnings',
      header: 'Earnings',
      align: 'right',
      mono: true,
      render: (r) => `$${r.earnings.toFixed(4)}`,
    },
  ]

  // Period selector rendered in the shell live label / actions area.
  const periodSelector = (
    <div
      className="flex gap-1 rounded-md p-1"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
    >
      {(['day', 'week', 'month', 'all'] as Period[]).map(p => (
        <button
          key={p}
          onClick={() => setPeriod(p)}
          className="px-3 py-1 rounded-sm text-xs font-medium transition-all"
          style={period === p
            ? { background: 'var(--primary)', color: '#fff' }
            : { color: 'var(--text-muted)' }
          }
        >
          {p === 'day' ? 'Today' : p === 'week' ? 'Week' : p === 'month' ? 'Month' : 'All'}
        </button>
      ))}
    </div>
  )

  // Projections card (only on monthly period when there is data)
  const projections = (() => {
    if (!data || data.total <= 0 || period !== 'month') return null
    const uniqueDays = new Set(data.earnings.map(e => e.date?.slice(0, 10))).size || 1
    const dailyAvg = data.total / uniqueDays
    const projectedMonthly = dailyAvg * 30
    const projectedYearly = dailyAvg * 365
    return (
      <SectionCard title="Earnings Projections" icon={CalendarDays}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Daily Average</p>
            <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>${dailyAvg.toFixed(2)}</p>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>Based on {uniqueDays} day{uniqueDays !== 1 ? 's' : ''}</p>
          </div>
          <div className="p-4 rounded-lg" style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Projected Monthly</p>
            <p className="text-xl font-bold" style={{ color: 'var(--primary)' }}>${projectedMonthly.toFixed(2)}</p>
          </div>
          <div className="p-4 rounded-lg" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.2)' }}>
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Projected Yearly</p>
            <p className="text-xl font-bold" style={{ color: 'var(--info)' }}>${projectedYearly.toFixed(2)}</p>
          </div>
        </div>
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>Based on your earnings data. Actual results may vary.</p>
      </SectionCard>
    )
  })()

  const byMarketSection = (() => {
    const entries = Object.entries(data?.byMarket ?? {})
    if (entries.length === 0) return null
    return (
      <SectionCard title="Earnings by Market" icon={BarChart3}>
        <div className="space-y-3">
          {entries.map(([market, amount]) => {
            const colors = getMarketColor(market)
            const pct = data?.total ? (amount / data.total) * 100 : 0
            return (
              <div key={market} className="flex items-center gap-4">
                <span
                  className="text-xs font-semibold px-2.5 py-1 rounded-full w-24 text-center"
                  style={{ background: colors.bg, color: colors.text }}
                >
                  {market}
                </span>
                <div className="flex-1 rounded-full h-2 overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: colors.bar }}
                  />
                </div>
                <span className="text-sm font-medium w-24 text-right font-mono" style={{ color: 'var(--text-primary)' }}>${amount.toFixed(2)}</span>
              </div>
            )
          })}
        </div>
      </SectionCard>
    )
  })()

  return (
    <DashboardShell
      title="Earnings"
      subtitle="Track your GPU compute earnings across all markets"
    >
      <div className="lg:col-span-3 flex flex-col gap-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          {periodSelector}
          <div className="flex items-center gap-2">
            <Link href="/withdrawals">
              <Button size="sm">
                <ArrowDownToLine size={14} className="mr-1.5" />
                Withdraw
              </Button>
            </Link>
            <Link href="/earnings/history">
              <Button variant="secondary" size="sm">
                <History size={14} className="mr-1.5" />
                Full History
              </Button>
            </Link>
          </div>
        </div>

        <MetricTriad metrics={metrics} />

        {byMarketSection}

        {projections}

        <DataTableCard<EarningTableRow>
          title="Recent Earnings"
          icon={TrendingUp}
          columns={columns}
          rows={(data?.earnings ?? []) as EarningTableRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={TrendingUp}
              title="No earnings yet"
              description={`No earnings recorded for ${PERIOD_LABELS[period].toLowerCase()}.`}
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
