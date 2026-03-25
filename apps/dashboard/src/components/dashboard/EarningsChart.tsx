'use client'

import { useEffect, useState, useMemo } from 'react'
import { Card } from '@/components/ui/Card'
import { SkeletonChart } from '@/components/ui/Skeleton'
import { api } from '@/lib/api'

interface EarningsData {
  date: string
  internal: number
  akash: number
  ionet: number
  total: number
}

type Period = '7d' | '30d' | '90d'

const marketColors = {
  internal: {
    bar: 'bg-gradient-to-t from-accent to-emerald-400',
    text: 'text-accent',
    bg: 'bg-accent',
    glow: 'shadow-[0_0_10px_rgba(34,197,94,0.3)]',
  },
  akash: {
    bar: 'bg-gradient-to-t from-accent-blue to-blue-400',
    text: 'text-accent-blue',
    bg: 'bg-accent-blue',
    glow: 'shadow-[0_0_10px_rgba(59,130,246,0.3)]',
  },
  ionet: {
    bar: 'bg-gradient-to-t from-accent-purple to-purple-400',
    text: 'text-accent-purple',
    bg: 'bg-accent-purple',
    glow: 'shadow-[0_0_10px_rgba(139,92,246,0.3)]',
  },
}

export function EarningsChart() {
  const [data, setData] = useState<EarningsData[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('7d')
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  useEffect(() => {
    loadEarningsData()
  }, [period])

  async function loadEarningsData() {
    setLoading(true)
    try {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
      const response = await api.stats.earningsTrend(days)
      setData(response.data || [])
    } catch {
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
    } finally {
      setLoading(false)
    }
  }

  const { maxValue, totals } = useMemo(() => {
    const max = Math.max(...data.map(d => d.total), 1)
    return {
      maxValue: max,
      totals: {
        total: data.reduce((sum, d) => sum + d.total, 0),
        internal: data.reduce((sum, d) => sum + d.internal, 0),
        akash: data.reduce((sum, d) => sum + d.akash, 0),
        ionet: data.reduce((sum, d) => sum + d.ionet, 0),
      },
    }
  }, [data])

  const periodLabel = period === '7d' ? 'Last 7 days' : period === '30d' ? 'Last 30 days' : 'Last 90 days'

  return (
    <Card
      variant="glass"
      hover={false}
      className="overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Earnings Overview</h3>
          <p className="text-sm text-text-muted mt-0.5">{periodLabel}</p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-surface rounded-lg border border-border">
          {(['7d', '30d', '90d'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`
                px-3 py-1.5 text-xs font-medium rounded-md
                transition-all duration-300
                ${period === p
                  ? 'bg-accent text-background shadow-lg shadow-accent/20'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'
                }
              `}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <SkeletonChart />
      ) : (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <SummaryStat
              label="Total"
              value={totals.total}
              color="accent"
              isTotal
            />
            <SummaryStat
              label="Internal"
              value={totals.internal}
              color="internal"
            />
            <SummaryStat
              label="Akash"
              value={totals.akash}
              color="akash"
            />
            <SummaryStat
              label="IO.net"
              value={totals.ionet}
              color="ionet"
            />
          </div>

          {/* Chart */}
          <div className="relative">
            {/* Y-axis labels */}
            <div className="absolute left-0 top-0 bottom-8 w-12 flex flex-col justify-between text-right pr-2 pointer-events-none">
              <span className="text-[10px] text-text-muted">${(maxValue).toFixed(0)}</span>
              <span className="text-[10px] text-text-muted">${(maxValue / 2).toFixed(0)}</span>
              <span className="text-[10px] text-text-muted">$0</span>
            </div>

            {/* Grid lines */}
            <div className="absolute left-12 right-0 top-0 bottom-8 pointer-events-none">
              <div className="absolute top-0 left-0 right-0 border-t border-border/30" />
              <div className="absolute top-1/2 left-0 right-0 border-t border-border/30 border-dashed" />
              <div className="absolute bottom-0 left-0 right-0 border-t border-border/30" />
            </div>

            {/* Bars */}
            <div className="h-56 flex items-end gap-1 pl-12">
              {data.map((item, i) => {
                const height = (item.total / maxValue) * 100
                const internalHeight = item.total > 0 ? (item.internal / item.total) * height : 0
                const akashHeight = item.total > 0 ? (item.akash / item.total) * height : 0
                const ionetHeight = item.total > 0 ? (item.ionet / item.total) * height : 0
                const isHovered = hoveredBar === i

                return (
                  <div
                    key={item.date}
                    className="flex-1 flex flex-col justify-end group relative cursor-pointer"
                    onMouseEnter={() => setHoveredBar(i)}
                    onMouseLeave={() => setHoveredBar(null)}
                  >
                    {/* Tooltip */}
                    {isHovered && (
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20 animate-scaleIn">
                        <div className="bg-surface/95 backdrop-blur-xl border border-border rounded-xl p-3 shadow-xl whitespace-nowrap">
                          <p className="text-xs text-text-muted mb-1">
                            {new Date(item.date).toLocaleDateString('en-US', {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                            })}
                          </p>
                          <p className="text-lg font-bold text-accent">${item.total.toFixed(2)}</p>
                          <div className="text-xs mt-2 space-y-1">
                            <div className="flex items-center justify-between gap-4">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-accent" />
                                Internal
                              </span>
                              <span className="text-accent font-medium">${item.internal.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-accent-blue" />
                                Akash
                              </span>
                              <span className="text-accent-blue font-medium">${item.akash.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                              <span className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-accent-purple" />
                                IO.net
                              </span>
                              <span className="text-accent-purple font-medium">${item.ionet.toFixed(2)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Stacked Bar */}
                    <div
                      className={`
                        flex flex-col rounded-t-sm overflow-hidden
                        transition-all duration-300
                        ${isHovered ? 'scale-[1.02] brightness-110' : ''}
                      `}
                    >
                      <div
                        className={`${marketColors.ionet.bar} transition-all duration-500`}
                        style={{ height: `${ionetHeight}%`, minHeight: item.ionet > 0 ? '2px' : '0' }}
                      />
                      <div
                        className={`${marketColors.akash.bar} transition-all duration-500`}
                        style={{ height: `${akashHeight}%`, minHeight: item.akash > 0 ? '2px' : '0' }}
                      />
                      <div
                        className={`${marketColors.internal.bar} transition-all duration-500`}
                        style={{ height: `${internalHeight}%`, minHeight: item.internal > 0 ? '2px' : '0' }}
                      />
                    </div>

                    {/* Date label */}
                    {(i === 0 || i === data.length - 1 || (data.length <= 14 && i % 2 === 0) || (data.length > 14 && i % 7 === 0)) && (
                      <p className="text-[10px] text-text-muted text-center mt-2 truncate">
                        {new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-6 mt-6 pt-4 border-t border-border/50">
            <LegendItem color="accent" label="Internal" />
            <LegendItem color="accent-blue" label="Akash" />
            <LegendItem color="accent-purple" label="IO.net" />
          </div>
        </>
      )}
    </Card>
  )
}

function SummaryStat({
  label,
  value,
  color,
  isTotal = false,
}: {
  label: string
  value: number
  color: string
  isTotal?: boolean
}) {
  const colorClasses: Record<string, string> = {
    accent: 'text-accent',
    internal: 'text-accent',
    akash: 'text-accent-blue',
    ionet: 'text-accent-purple',
  }

  return (
    <div className={`
      p-3 rounded-lg border transition-all duration-300
      ${isTotal
        ? 'bg-accent/5 border-accent/20 hover:border-accent/40'
        : 'bg-surface border-border/50 hover:border-border'
      }
    `}>
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${colorClasses[color]}`}>
        ${value.toFixed(2)}
      </p>
    </div>
  )
}

function LegendItem({ color, label }: { color: string; label: string }) {
  const bgClasses: Record<string, string> = {
    accent: 'bg-accent',
    'accent-blue': 'bg-accent-blue',
    'accent-purple': 'bg-accent-purple',
  }

  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded ${bgClasses[color]}`} />
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  )
}
