'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface EarningsData {
  earnings: Array<{ id: string; nodeId: string; date: string; market: string; earnings: number; jobCount: number }>
  total: number
  byMarket: Record<string, number>
  byNode: Record<string, number>
}

type Period = 'day' | 'week' | 'month' | 'all'

export default function EarningsPage() {
  const [data, setData] = useState<EarningsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')

  useEffect(() => { loadData() }, [period])

  async function loadData() {
    setLoading(true)
    try {
      const d = await nodeRunner.earnings(period) as EarningsData
      setData(d)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const marketColors: Record<string, { bg: string; text: string; bar: string }> = {
    INTERNAL: { bg: 'bg-accent/10', text: 'text-accent', bar: 'bg-accent' },
    AKASH: { bg: 'bg-accent-blue/10', text: 'text-accent-blue', bar: 'bg-accent-blue' },
    IONET: { bg: 'bg-accent-purple/10', text: 'text-accent-purple', bar: 'bg-accent-purple' },
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Earnings</h1>
          <p className="text-sm text-text-muted mt-1">Track your GPU compute earnings across all markets</p>
        </div>
        <Link href="/earnings/history"><Button variant="secondary" size="sm">View Full History</Button></Link>
      </div>

      {/* Period Selector */}
      <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 w-fit">
        {([['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All Time']] as [Period, string][]).map(([p, label]) => (
          <button key={p} onClick={() => setPeriod(p)} className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${period === p ? 'bg-accent text-white' : 'text-text-muted hover:text-text-secondary'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-32" />)}</div>
      ) : (
        <>
          {/* Total */}
          <Card className="p-6 bg-gradient-to-r from-accent/5 via-surface to-surface border-accent/20">
            <p className="text-sm text-text-muted mb-1">Total Earnings ({period === 'day' ? 'Today' : period === 'week' ? 'This Week' : period === 'month' ? 'This Month' : 'All Time'})</p>
            <p className="text-4xl font-bold text-text-primary">${(data?.total ?? 0).toFixed(2)}</p>
          </Card>

          {/* By Market */}
          <Card className="p-6">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Earnings by Market</h2>
            {Object.entries(data?.byMarket ?? {}).length === 0 ? (
              <p className="text-sm text-text-muted text-center py-4">No earnings data for this period</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(data?.byMarket ?? {}).map(([market, amount]) => {
                  const colors = marketColors[market] ?? { bg: 'bg-surface-hover', text: 'text-text-secondary', bar: 'bg-text-muted' }
                  const pct = data?.total ? (amount / data.total) * 100 : 0
                  return (
                    <div key={market} className="flex items-center gap-4">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${colors.bg} ${colors.text} w-24 text-center`}>{market}</span>
                      <div className="flex-1 bg-surface-hover rounded-full h-2 overflow-hidden">
                        <div className={`h-full rounded-full ${colors.bar} transition-all duration-500`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-sm font-medium text-text-primary w-24 text-right">${amount.toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          {/* Projections */}
          {data && data.total > 0 && period === 'month' && (
            <Card className="p-6">
              <h2 className="text-sm font-semibold text-text-primary mb-4">Earnings Projections</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-4 bg-surface-hover rounded-lg">
                  <p className="text-xs text-text-muted mb-1">Daily Average</p>
                  <p className="text-xl font-bold text-text-primary">${(data.total / 30).toFixed(2)}</p>
                </div>
                <div className="p-4 bg-accent/5 border border-accent/20 rounded-lg">
                  <p className="text-xs text-text-muted mb-1">Projected Monthly</p>
                  <p className="text-xl font-bold text-accent">${data.total.toFixed(2)}</p>
                </div>
                <div className="p-4 bg-accent-blue/5 border border-accent-blue/20 rounded-lg">
                  <p className="text-xs text-text-muted mb-1">Projected Yearly</p>
                  <p className="text-xl font-bold text-accent-blue">${(data.total * 12).toFixed(2)}</p>
                </div>
              </div>
              <p className="text-2xs text-text-muted mt-3">Based on your last 30 days of earnings. Actual results may vary.</p>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
