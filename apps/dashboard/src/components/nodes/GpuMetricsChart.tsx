'use client'

import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { BarChart3 } from 'lucide-react'
import { Card } from '@/components/ui/Card'

interface MetricDataPoint {
  timestamp: string
  gpuUtilization: number | null
  gpuTemperature: number | null
  gpuMemoryUsed: number | null
  gpuMemoryTotal: number | null
}

interface GpuMetricsChartProps {
  data: MetricDataPoint[]
  title?: string
  className?: string
}

type TimeRange = '1h' | '6h' | '24h' | '7d'
type MetricType = 'utilization' | 'temperature' | 'memory'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1 Hour' },
  { value: '6h', label: '6 Hours' },
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
]

const METRIC_TYPES: { value: MetricType; label: string; color: string; cssVar: string }[] = [
  { value: 'utilization', label: 'GPU Usage', color: '#22c55e', cssVar: 'var(--success)' },
  { value: 'temperature', label: 'Temperature', color: '#f59e0b', cssVar: 'var(--warning)' },
  { value: 'memory', label: 'Memory', color: '#3b82f6', cssVar: 'var(--info)' },
]

export function GpuMetricsChart({ data, title = 'GPU Metrics', className = '' }: GpuMetricsChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('1h')
  const [selectedMetric, setSelectedMetric] = useState<MetricType>('utilization')

  const filteredData = useMemo(() => {
    const now = new Date()
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    }

    const cutoff = now.getTime() - ranges[timeRange]
    return data.filter(d => new Date(d.timestamp).getTime() >= cutoff)
  }, [data, timeRange])

  const chartData = useMemo(() => {
    return filteredData.map(d => {
      let value: number | null = null
      switch (selectedMetric) {
        case 'utilization':
          value = d.gpuUtilization
          break
        case 'temperature':
          value = d.gpuTemperature
          break
        case 'memory':
          if (d.gpuMemoryUsed && d.gpuMemoryTotal) {
            value = (d.gpuMemoryUsed / d.gpuMemoryTotal) * 100
          }
          break
      }
      return {
        timestamp: d.timestamp,
        value,
      }
    })
  }, [filteredData, selectedMetric])

  const stats = useMemo(() => {
    const values = chartData.filter(d => d.value !== null).map(d => d.value as number)
    if (values.length === 0) return { min: 0, max: 100, avg: 0 }
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
    }
  }, [chartData])

  const pathData = useMemo(() => {
    if (chartData.length === 0) return ''

    const width = 100
    const height = 40
    const padding = 2

    const validPoints = chartData.filter(d => d.value !== null)
    if (validPoints.length < 2) return ''

    const xStep = (width - padding * 2) / (validPoints.length - 1)
    const yScale = (height - padding * 2) / 100

    const points = validPoints.map((d, i) => ({
      x: padding + i * xStep,
      y: height - padding - (d.value as number) * yScale,
    }))

    let path = `M ${points[0].x} ${points[0].y}`
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const curr = points[i]
      const cpx = (prev.x + curr.x) / 2
      path += ` Q ${cpx} ${prev.y}, ${curr.x} ${curr.y}`
    }

    return path
  }, [chartData])

  const currentMetric = METRIC_TYPES.find(m => m.value === selectedMetric)!
  const strokeColor = currentMetric.color

  const getUnit = (type: MetricType) => {
    switch (type) {
      case 'utilization': return '%'
      case 'temperature': return '\u00B0C'
      case 'memory': return '%'
      default: return ''
    }
  }

  return (
    <motion.div variants={container} initial="hidden" animate="show">
      <Card variant="glass" hover={false} className={className}>
        <motion.div variants={item} className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
              <BarChart3 size={20} style={{ color: 'var(--bg-primary)' }} />
            </div>
            <div>
              <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{filteredData.length} data points</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-lg p-0.5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
              {TIME_RANGES.map(range => (
                <button
                  key={range.value}
                  onClick={() => setTimeRange(range.value)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md transition-all"
                  style={timeRange === range.value
                    ? { background: 'var(--primary)', color: '#fff' }
                    : { color: 'var(--text-muted)' }
                  }
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Metric Type Tabs */}
        <motion.div variants={item} className="flex items-center gap-2 mb-4">
          {METRIC_TYPES.map(metric => (
            <button
              key={metric.value}
              onClick={() => setSelectedMetric(metric.value)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg transition-all"
              style={selectedMetric === metric.value
                ? { background: `${metric.color}15`, color: metric.cssVar, border: `1px solid ${metric.color}30` }
                : { background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
              }
            >
              {metric.label}
            </button>
          ))}
        </motion.div>

        {/* Chart Area */}
        <motion.div variants={item} className="relative h-32 mb-4">
          {chartData.length > 1 ? (
            <svg
              viewBox="0 0 100 40"
              preserveAspectRatio="none"
              className="w-full h-full"
            >
              <line x1="0" y1="10" x2="100" y2="10" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.2" />
              <line x1="0" y1="20" x2="100" y2="20" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.2" />
              <line x1="0" y1="30" x2="100" y2="30" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.2" />

              <path
                d={`${pathData} L 98 38 L 2 38 Z`}
                fill={strokeColor}
                fillOpacity="0.1"
              />

              <path
                d={pathData}
                fill="none"
                stroke={strokeColor}
                strokeWidth="0.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Not enough data to display chart</p>
            </div>
          )}
        </motion.div>

        {/* Stats Row */}
        <motion.div variants={item} className="grid grid-cols-3 gap-4 pt-4" style={{ borderTop: '1px solid var(--border-color)' }}>
          <div className="text-center">
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Min</p>
            <p className="text-lg font-semibold" style={{ color: currentMetric.cssVar }}>
              {stats.min.toFixed(1)}{getUnit(selectedMetric)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Average</p>
            <p className="text-lg font-semibold" style={{ color: currentMetric.cssVar }}>
              {stats.avg.toFixed(1)}{getUnit(selectedMetric)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Max</p>
            <p className="text-lg font-semibold" style={{ color: currentMetric.cssVar }}>
              {stats.max.toFixed(1)}{getUnit(selectedMetric)}
            </p>
          </div>
        </motion.div>
      </Card>
    </motion.div>
  )
}
