'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { TrendingUp, BarChart3, CalendarDays, ArrowDownToLine } from 'lucide-react'
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

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface WithdrawalBalance {
  availableBalance: number
}

export default function EarningsPage() {
  const [data, setData] = useState<EarningsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [withdrawalBalance, setWithdrawalBalance] = useState<number | null>(null)

  useEffect(() => { loadData() }, [period])

  useEffect(() => {
    nodeRunner.withdrawalBalance()
      .then((res) => setWithdrawalBalance((res as WithdrawalBalance).availableBalance))
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

  const marketColors: Record<string, { bg: string; text: string; bar: string }> = {
    INTERNAL: { bg: 'rgba(34,197,94,0.1)', text: 'var(--success)', bar: 'var(--success)' },
    AKASH: { bg: 'rgba(59,130,246,0.1)', text: 'var(--info)', bar: 'var(--info)' },
    IONET: { bg: 'rgba(139,92,246,0.1)', text: '#8b5cf6', bar: '#8b5cf6' },
  }

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Earnings</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Track your GPU compute earnings across all markets</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {withdrawalBalance !== null && (
            <span
              className="text-xs font-medium px-3 py-1.5 rounded-lg"
              style={{ background: 'rgba(34,197,94,0.08)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.2)' }}
            >
              Available for withdrawal: ${withdrawalBalance.toFixed(2)}
            </span>
          )}
          <Link href="/withdrawals">
            <Button size="sm">
              <ArrowDownToLine size={14} className="mr-1.5" />
              Withdraw
            </Button>
          </Link>
          <Link href="/earnings/history"><Button variant="secondary" size="sm">View Full History</Button></Link>
        </div>
      </motion.div>

      {/* Period Selector */}
      <motion.div variants={item}>
        <div
          className="flex gap-1 rounded-lg p-1 w-fit"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
        >
          {([['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['all', 'All Time']] as [Period, string][]).map(([p, label]) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="px-4 py-2 rounded-md text-sm font-medium transition-all"
              style={period === p
                ? { background: 'var(--primary)', color: '#fff' }
                : { color: 'var(--text-muted)' }
              }
            >
              {label}
            </button>
          ))}
        </div>
      </motion.div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-32" />)}</div>
      ) : (
        <>
          {/* Total */}
          <motion.div variants={item}>
            <div
              className="rounded-xl p-6"
              style={{
                background: 'linear-gradient(to right, rgba(34,197,94,0.05), var(--glass-bg))',
                border: '1px solid rgba(34,197,94,0.2)',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp size={16} style={{ color: 'var(--primary)' }} />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Total Earnings ({period === 'day' ? 'Today' : period === 'week' ? 'This Week' : period === 'month' ? 'This Month' : 'All Time'})
                </p>
              </div>
              <p className="text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>${(data?.total ?? 0).toFixed(2)}</p>
            </div>
          </motion.div>

          {/* By Market */}
          <motion.div variants={item}>
            <div
              className="rounded-xl p-6"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
            >
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 size={16} style={{ color: 'var(--text-secondary)' }} />
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Earnings by Market</h2>
              </div>
              {Object.entries(data?.byMarket ?? {}).length === 0 ? (
                <p className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>No earnings data for this period</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(data?.byMarket ?? {}).map(([market, amount]) => {
                    const colors = marketColors[market] ?? { bg: 'var(--bg-card-hover)', text: 'var(--text-secondary)', bar: 'var(--text-muted)' }
                    const pct = data?.total ? (amount / data.total) * 100 : 0
                    return (
                      <div key={market} className="flex items-center gap-4">
                        <span
                          className="text-xs font-semibold px-2.5 py-1 rounded-full w-24 text-center"
                          style={{ background: colors.bg, color: colors.text }}
                        >
                          {market}
                        </span>
                        <div className="flex-1 rounded-full h-2 overflow-hidden" style={{ background: 'var(--bg-card-hover)' }}>
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${pct}%`, background: colors.bar }}
                          />
                        </div>
                        <span className="text-sm font-medium w-24 text-right" style={{ color: 'var(--text-primary)' }}>${amount.toFixed(2)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </motion.div>

          {/* Projections */}
          {data && data.total > 0 && period === 'month' && (
            <motion.div variants={item}>
              <div
                className="rounded-xl p-6"
                style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
              >
                <div className="flex items-center gap-2 mb-4">
                  <CalendarDays size={16} style={{ color: 'var(--text-secondary)' }} />
                  <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Earnings Projections</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="p-4 rounded-lg" style={{ background: 'var(--bg-card-hover)' }}>
                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Daily Average</p>
                    <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>${(data.total / 30).toFixed(2)}</p>
                  </div>
                  <div className="p-4 rounded-lg" style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}>
                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Projected Monthly</p>
                    <p className="text-xl font-bold" style={{ color: 'var(--primary)' }}>${data.total.toFixed(2)}</p>
                  </div>
                  <div className="p-4 rounded-lg" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.2)' }}>
                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Projected Yearly</p>
                    <p className="text-xl font-bold" style={{ color: 'var(--info)' }}>${(data.total * 12).toFixed(2)}</p>
                  </div>
                </div>
                <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>Based on your last 30 days of earnings. Actual results may vary.</p>
              </div>
            </motion.div>
          )}
        </>
      )}
    </motion.div>
  )
}
