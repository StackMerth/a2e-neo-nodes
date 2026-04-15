'use client'

import { Cpu, Thermometer } from 'lucide-react'

interface GpuHealthBadgeProps {
  utilization: number | null
  temperature: number | null
  memoryUsed?: number | null
  memoryTotal?: number | null
  showLabel?: boolean
  size?: 'sm' | 'md' | 'lg'
}

type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

function getHealthStatus(
  utilization: number | null,
  temperature: number | null
): HealthStatus {
  if (utilization === null && temperature === null) {
    return 'unknown'
  }

  if ((temperature !== null && temperature > 85) || (utilization !== null && utilization > 95)) {
    return 'critical'
  }

  if ((temperature !== null && temperature > 75) || (utilization !== null && utilization > 85)) {
    return 'warning'
  }

  return 'healthy'
}

const STATUS_CONFIG: Record<HealthStatus, {
  label: string
  color: string
  bgColor: string
  borderColor: string
  dotColor: string
  dotShadow: string
}> = {
  healthy: {
    label: 'Healthy',
    color: 'var(--success)',
    bgColor: 'rgba(34,197,94,0.1)',
    borderColor: 'rgba(34,197,94,0.2)',
    dotColor: 'var(--success)',
    dotShadow: '0 0 8px rgba(34,197,94,0.6)',
  },
  warning: {
    label: 'Warning',
    color: 'var(--warning)',
    bgColor: 'rgba(245,158,11,0.1)',
    borderColor: 'rgba(245,158,11,0.2)',
    dotColor: 'var(--warning)',
    dotShadow: '0 0 8px rgba(245,158,11,0.6)',
  },
  critical: {
    label: 'Critical',
    color: 'var(--danger)',
    bgColor: 'rgba(239,68,68,0.1)',
    borderColor: 'rgba(239,68,68,0.2)',
    dotColor: 'var(--danger)',
    dotShadow: '0 0 8px rgba(239,68,68,0.6)',
  },
  unknown: {
    label: 'Unknown',
    color: 'var(--text-muted)',
    bgColor: 'var(--bg-card)',
    borderColor: 'var(--border-color)',
    dotColor: 'var(--text-muted)',
    dotShadow: 'none',
  },
}

const SIZE_CONFIG = {
  sm: {
    padding: 'px-2 py-0.5',
    text: 'text-xs',
    dot: 'w-1.5 h-1.5',
    gap: 'gap-1',
  },
  md: {
    padding: 'px-2.5 py-1',
    text: 'text-xs',
    dot: 'w-2 h-2',
    gap: 'gap-1.5',
  },
  lg: {
    padding: 'px-3 py-1.5',
    text: 'text-sm',
    dot: 'w-2.5 h-2.5',
    gap: 'gap-2',
  },
}

export function GpuHealthBadge({
  utilization,
  temperature,
  showLabel = true,
  size = 'md',
}: GpuHealthBadgeProps) {
  const status = getHealthStatus(utilization, temperature)
  const config = STATUS_CONFIG[status]
  const sizeConfig = SIZE_CONFIG[size]

  return (
    <div
      className={`inline-flex items-center ${sizeConfig.gap} ${sizeConfig.padding} rounded-lg font-medium`}
      style={{
        background: config.bgColor,
        border: `1px solid ${config.borderColor}`,
        color: config.color,
      }}
    >
      <span
        className={`${sizeConfig.dot} rounded-full`}
        style={{
          background: config.dotColor,
          boxShadow: config.dotShadow,
        }}
      />
      {showLabel && <span className={sizeConfig.text}>{config.label}</span>}
    </div>
  )
}

/**
 * Compact version showing metrics inline
 */
export function GpuMetricsBadge({
  utilization,
  temperature,
}: Pick<GpuHealthBadgeProps, 'utilization' | 'temperature' | 'size'>) {
  const status = getHealthStatus(utilization, temperature)
  const config = STATUS_CONFIG[status]

  const getUtilColor = (val: number) => {
    if (val > 85) return 'var(--danger)'
    if (val > 70) return 'var(--warning)'
    return 'var(--text-primary)'
  }

  const getTempColor = (val: number) => {
    if (val > 80) return 'var(--danger)'
    if (val > 70) return 'var(--warning)'
    return 'var(--text-primary)'
  }

  return (
    <div className="inline-flex items-center gap-3">
      {utilization !== null && (
        <div className="flex items-center gap-1.5">
          <Cpu size={14} style={{ color: 'var(--text-muted)' }} />
          <span
            className="text-xs font-medium tabular-nums"
            style={{ color: getUtilColor(utilization) }}
          >
            {utilization.toFixed(0)}%
          </span>
        </div>
      )}

      {temperature !== null && (
        <div className="flex items-center gap-1.5">
          <Thermometer size={14} style={{ color: 'var(--text-muted)' }} />
          <span
            className="text-xs font-medium tabular-nums"
            style={{ color: getTempColor(temperature) }}
          >
            {temperature.toFixed(0)}{'\u00B0'}C
          </span>
        </div>
      )}

      <span
        className="w-2 h-2 rounded-full"
        style={{
          background: config.dotColor,
          boxShadow: config.dotShadow,
        }}
      />
    </div>
  )
}
