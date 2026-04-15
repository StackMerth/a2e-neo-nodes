'use client'

import { useMemo } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'

/* -----------------------------------------------
   Types
   ----------------------------------------------- */

interface EarningsChartProps {
  data: Array<{ date: string; earnings: number }>
}

/* -----------------------------------------------
   Custom Tooltip
   ----------------------------------------------- */

interface PayloadItem {
  value: number
  payload: { date: string; earnings: number }
}

function EarningsTooltip({ active, payload }: { active?: boolean; payload?: PayloadItem[] }) {
  if (!active || !payload?.length) return null
  const item = payload[0]
  return (
    <div className="dash-tooltip">
      <p className="dash-tooltip-label">{item.payload.date}</p>
      <p className="dash-tooltip-value" style={{ color: '#22c55e', fontWeight: 700 }}>
        ${item.value.toFixed(2)}
      </p>
    </div>
  )
}

/* -----------------------------------------------
   Component
   ----------------------------------------------- */

export function EarningsChart({ data }: EarningsChartProps) {
  const gradientId = 'earningsGradient'

  const maxEarnings = useMemo(
    () => Math.max(...data.map((d) => d.earnings), 1),
    [data],
  )

  if (!data.length) {
    return (
      <div className="dash-chart-card">
        <h3 className="dash-chart-title">Earnings Trend</h3>
        <div className="dash-chart-empty">No earnings data available</div>
      </div>
    )
  }

  return (
    <div className="dash-chart-card">
      <h3 className="dash-chart-title">Earnings Trend</h3>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            interval="preserveStartEnd"
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
            tickFormatter={(v: number) => `$${v}`}
            domain={[0, maxEarnings * 1.1]}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<EarningsTooltip />} />
          <Area
            type="monotone"
            dataKey="earnings"
            stroke="#22c55e"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            animationDuration={800}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
