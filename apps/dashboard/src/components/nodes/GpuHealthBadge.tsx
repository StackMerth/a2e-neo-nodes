'use client'

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

  // Critical: Temperature > 85°C or utilization > 95%
  if ((temperature !== null && temperature > 85) || (utilization !== null && utilization > 95)) {
    return 'critical'
  }

  // Warning: Temperature > 75°C or utilization > 85%
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
}> = {
  healthy: {
    label: 'Healthy',
    color: 'text-accent',
    bgColor: 'bg-accent/10',
    borderColor: 'border-accent/20',
    dotColor: 'bg-accent shadow-[0_0_8px_rgba(34,197,94,0.6)]',
  },
  warning: {
    label: 'Warning',
    color: 'text-warning',
    bgColor: 'bg-warning/10',
    borderColor: 'border-warning/20',
    dotColor: 'bg-warning shadow-[0_0_8px_rgba(245,158,11,0.6)]',
  },
  critical: {
    label: 'Critical',
    color: 'text-error',
    bgColor: 'bg-error/10',
    borderColor: 'border-error/20',
    dotColor: 'bg-error shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse',
  },
  unknown: {
    label: 'Unknown',
    color: 'text-text-muted',
    bgColor: 'bg-surface',
    borderColor: 'border-border',
    dotColor: 'bg-text-muted',
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
      className={`
        inline-flex items-center ${sizeConfig.gap} ${sizeConfig.padding}
        rounded-lg border font-medium
        ${config.bgColor} ${config.borderColor} ${config.color}
      `}
    >
      <span className={`${sizeConfig.dot} rounded-full ${config.dotColor}`} />
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
  size = 'sm',
}: Pick<GpuHealthBadgeProps, 'utilization' | 'temperature' | 'size'>) {
  const status = getHealthStatus(utilization, temperature)
  const config = STATUS_CONFIG[status]

  return (
    <div className="inline-flex items-center gap-3">
      {/* GPU Usage */}
      {utilization !== null && (
        <div className="flex items-center gap-1.5">
          <GpuIcon className="w-3.5 h-3.5 text-text-muted" />
          <span className={`text-xs font-medium tabular-nums ${
            utilization > 85 ? 'text-error' : utilization > 70 ? 'text-warning' : 'text-text-primary'
          }`}>
            {utilization.toFixed(0)}%
          </span>
        </div>
      )}

      {/* Temperature */}
      {temperature !== null && (
        <div className="flex items-center gap-1.5">
          <ThermometerIcon className="w-3.5 h-3.5 text-text-muted" />
          <span className={`text-xs font-medium tabular-nums ${
            temperature > 80 ? 'text-error' : temperature > 70 ? 'text-warning' : 'text-text-primary'
          }`}>
            {temperature.toFixed(0)}°C
          </span>
        </div>
      )}

      {/* Health dot */}
      <span className={`w-2 h-2 rounded-full ${config.dotColor}`} />
    </div>
  )
}

// Icons
function GpuIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  )
}

function ThermometerIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9V3m0 0L9 6m3-3l3 3m-3 14a4 4 0 100-8 4 4 0 000 8z" />
    </svg>
  )
}
