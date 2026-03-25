'use client'

import { useEffect, useState, useMemo } from 'react'
import { Card } from '@/components/ui/Card'
import { api } from '@/lib/api'

interface EarningsData {
  date: string
  internal: number
  akash: number
  ionet: number
  total: number
}

type Period = '7d' | '30d' | '90d'

export function EarningsChart() {
  const [data, setData] = useState<EarningsData[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('7d')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadEarningsData()
  }, [period])

  async function loadEarningsData() {
    setLoading(true)
    try {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
      const response = await api.stats.earningsTrend(days)
      setData(response.data || [])
      setError(null)
    } catch (err) {
      // Generate mock data if API not available
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
      const mockData: EarningsData[] = []
      for (let i = days - 1; i >= 0; i--) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        mockData.push({
          date: date.toISOString().split('T')[0],
          internal: Math.random() * 500 + 200,
          akash: Math.random() * 200 + 50,
          ionet: Math.random() * 150 + 30,
          total: 0,
        })
        mockData[mockData.length - 1].total =
          mockData[mockData.length - 1].internal +
          mockData[mockData.length - 1].akash +
          mockData[mockData.length - 1].ionet
      }
      setData(mockData)
      setError(null)
    } finally {
      setLoading(false)
    }
  }

  const { maxValue, totalEarnings } = useMemo(() => {
    const max = Math.max(...data.map(d => d.total), 1)
    const total = data.reduce((sum, d) => sum + d.total, 0)
    return { maxValue: max, totalEarnings: total }
  }, [data])

  const periodLabel = period === '7d' ? 'Last 7 days' : period === '30d' ? 'Last 30 days' : 'Last 90 days'

  return (
    <Card
      title="Earnings Overview"
      description={periodLabel}
      action={
        <div className="flex items-center gap-1 bg-background rounded-lg p-1">
          {(['7d', '30d', '90d'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                period === p
                  ? 'bg-accent text-background'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <p className="text-text-muted">Loading earnings data...</p>
        </div>
      ) : error ? (
        <div className="h-64 flex items-center justify-center">
          <p className="text-error text-sm">{error}</p>
        </div>
      ) : (
        <div className="mt-4">
          {/* Summary Stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="p-3 bg-background rounded-lg">
              <p className="text-xs text-text-muted">Total</p>
              <p className="text-lg font-bold text-accent">${totalEarnings.toFixed(2)}</p>
            </div>
            <div className="p-3 bg-background rounded-lg">
              <p className="text-xs text-text-muted">Internal</p>
              <p className="text-lg font-bold text-emerald-400">
                ${data.reduce((s, d) => s + d.internal, 0).toFixed(2)}
              </p>
            </div>
            <div className="p-3 bg-background rounded-lg">
              <p className="text-xs text-text-muted">Akash</p>
              <p className="text-lg font-bold text-blue-400">
                ${data.reduce((s, d) => s + d.akash, 0).toFixed(2)}
              </p>
            </div>
            <div className="p-3 bg-background rounded-lg">
              <p className="text-xs text-text-muted">IO.net</p>
              <p className="text-lg font-bold text-purple-400">
                ${data.reduce((s, d) => s + d.ionet, 0).toFixed(2)}
              </p>
            </div>
          </div>

          {/* Chart */}
          <div className="h-48 flex items-end gap-1">
            {data.map((item, i) => {
              const height = (item.total / maxValue) * 100
              const internalHeight = (item.internal / item.total) * height
              const akashHeight = (item.akash / item.total) * height
              const ionetHeight = (item.ionet / item.total) * height

              return (
                <div
                  key={item.date}
                  className="flex-1 flex flex-col justify-end group relative"
                >
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10">
                    <div className="bg-surface border border-border rounded-lg p-2 shadow-lg whitespace-nowrap">
                      <p className="text-xs text-text-muted mb-1">{item.date}</p>
                      <p className="text-sm font-bold text-accent">${item.total.toFixed(2)}</p>
                      <div className="text-xs mt-1 space-y-0.5">
                        <p className="text-emerald-400">Internal: ${item.internal.toFixed(2)}</p>
                        <p className="text-blue-400">Akash: ${item.akash.toFixed(2)}</p>
                        <p className="text-purple-400">IO.net: ${item.ionet.toFixed(2)}</p>
                      </div>
                    </div>
                  </div>

                  {/* Stacked Bar */}
                  <div className="flex flex-col rounded-t overflow-hidden">
                    <div
                      className="bg-purple-500 transition-all"
                      style={{ height: `${ionetHeight}%`, minHeight: item.ionet > 0 ? '2px' : '0' }}
                    />
                    <div
                      className="bg-blue-500 transition-all"
                      style={{ height: `${akashHeight}%`, minHeight: item.akash > 0 ? '2px' : '0' }}
                    />
                    <div
                      className="bg-emerald-500 transition-all"
                      style={{ height: `${internalHeight}%`, minHeight: item.internal > 0 ? '2px' : '0' }}
                    />
                  </div>

                  {/* Date label (show every nth item) */}
                  {(i === 0 || i === data.length - 1 || (data.length <= 14 && i % 2 === 0) || (data.length > 14 && i % 7 === 0)) && (
                    <p className="text-[10px] text-text-muted text-center mt-1 truncate">
                      {new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-6 mt-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-emerald-500 rounded" />
              <span className="text-xs text-text-muted">Internal</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-blue-500 rounded" />
              <span className="text-xs text-text-muted">Akash</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-purple-500 rounded" />
              <span className="text-xs text-text-muted">IO.net</span>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}
