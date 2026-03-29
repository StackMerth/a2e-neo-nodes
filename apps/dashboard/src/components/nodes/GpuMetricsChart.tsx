'use client'

import { useState, useMemo } from 'react'
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

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1 Hour' },
  { value: '6h', label: '6 Hours' },
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
]

const METRIC_TYPES: { value: MetricType; label: string; color: string }[] = [
  { value: 'utilization', label: 'GPU Usage', color: 'accent' },
  { value: 'temperature', label: 'Temperature', color: 'orange' },
  { value: 'memory', label: 'Memory', color: 'blue' },
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

  // Generate SVG path for the chart
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

    // Create smooth curve using quadratic bezier
    let path = `M ${points[0].x} ${points[0].y}`
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const curr = points[i]
      const cpx = (prev.x + curr.x) / 2
      path += ` Q ${cpx} ${prev.y}, ${curr.x} ${curr.y}`
    }

    return path
  }, [chartData])

  const getColorClass = (type: string) => {
    switch (type) {
      case 'accent': return 'text-accent'
      case 'orange': return 'text-warning'
      case 'blue': return 'text-accent-blue'
      default: return 'text-accent'
    }
  }

  const getStrokeColor = (type: MetricType) => {
    switch (type) {
      case 'utilization': return '#22c55e'
      case 'temperature': return '#f59e0b'
      case 'memory': return '#3b82f6'
      default: return '#22c55e'
    }
  }

  const getUnit = (type: MetricType) => {
    switch (type) {
      case 'utilization': return '%'
      case 'temperature': return '°C'
      case 'memory': return '%'
      default: return ''
    }
  }

  return (
    <Card variant="glass" hover={false} className={className}>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-purple-400 flex items-center justify-center">
            <ChartIcon className="w-5 h-5 text-background" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">{title}</h3>
            <p className="text-xs text-text-muted">{filteredData.length} data points</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Time Range Selector */}
          <div className="flex items-center bg-surface rounded-lg p-0.5 border border-border/50">
            {TIME_RANGES.map(range => (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                className={`
                  px-3 py-1.5 text-xs font-medium rounded-md transition-all
                  ${timeRange === range.value
                    ? 'bg-accent text-background'
                    : 'text-text-muted hover:text-text-primary'
                  }
                `}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Metric Type Tabs */}
      <div className="flex items-center gap-2 mb-4">
        {METRIC_TYPES.map(metric => (
          <button
            key={metric.value}
            onClick={() => setSelectedMetric(metric.value)}
            className={`
              px-3 py-1.5 text-xs font-medium rounded-lg transition-all border
              ${selectedMetric === metric.value
                ? `bg-${metric.color}/10 ${getColorClass(metric.color)} border-${metric.color}/20`
                : 'bg-surface text-text-muted border-border/50 hover:text-text-primary'
              }
            `}
          >
            {metric.label}
          </button>
        ))}
      </div>

      {/* Chart Area */}
      <div className="relative h-32 mb-4">
        {chartData.length > 1 ? (
          <svg
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            className="w-full h-full"
          >
            {/* Grid lines */}
            <line x1="0" y1="10" x2="100" y2="10" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.2" />
            <line x1="0" y1="20" x2="100" y2="20" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.2" />
            <line x1="0" y1="30" x2="100" y2="30" stroke="currentColor" strokeOpacity="0.1" strokeWidth="0.2" />

            {/* Area fill */}
            <path
              d={`${pathData} L 98 38 L 2 38 Z`}
              fill={getStrokeColor(selectedMetric)}
              fillOpacity="0.1"
            />

            {/* Line */}
            <path
              d={pathData}
              fill="none"
              stroke={getStrokeColor(selectedMetric)}
              strokeWidth="0.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-text-muted text-sm">Not enough data to display chart</p>
          </div>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4 pt-4 border-t border-border/50">
        <div className="text-center">
          <p className="text-xs text-text-muted mb-1">Min</p>
          <p className={`text-lg font-semibold ${getColorClass(METRIC_TYPES.find(m => m.value === selectedMetric)?.color || 'accent')}`}>
            {stats.min.toFixed(1)}{getUnit(selectedMetric)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-text-muted mb-1">Average</p>
          <p className={`text-lg font-semibold ${getColorClass(METRIC_TYPES.find(m => m.value === selectedMetric)?.color || 'accent')}`}>
            {stats.avg.toFixed(1)}{getUnit(selectedMetric)}
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-text-muted mb-1">Max</p>
          <p className={`text-lg font-semibold ${getColorClass(METRIC_TYPES.find(m => m.value === selectedMetric)?.color || 'accent')}`}>
            {stats.max.toFixed(1)}{getUnit(selectedMetric)}
          </p>
        </div>
      </div>
    </Card>
  )
}

// Icon
function ChartIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
    </svg>
  )
}
