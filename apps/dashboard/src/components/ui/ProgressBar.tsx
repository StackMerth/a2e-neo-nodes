'use client'

import { useEffect, useState } from 'react'

// =============================================================================
// PROGRESS BAR
// =============================================================================

type ProgressVariant = 'accent' | 'blue' | 'purple' | 'orange' | 'gradient'
type ProgressSize = 'sm' | 'md' | 'lg'

interface ProgressBarProps {
  value: number
  max?: number
  variant?: ProgressVariant
  size?: ProgressSize
  showLabel?: boolean
  label?: string
  animate?: boolean
  glow?: boolean
  className?: string
}

const variantStyles: Record<ProgressVariant, string> = {
  accent: 'bg-gradient-accent',
  blue: 'bg-gradient-blue',
  purple: 'bg-gradient-purple',
  orange: 'bg-gradient-orange',
  gradient: 'bg-gradient-mixed',
}

const glowStyles: Record<ProgressVariant, string> = {
  accent: 'shadow-[0_0_10px_rgba(34,197,94,0.5)]',
  blue: 'shadow-[0_0_10px_rgba(59,130,246,0.5)]',
  purple: 'shadow-[0_0_10px_rgba(139,92,246,0.5)]',
  orange: 'shadow-[0_0_10px_rgba(245,158,11,0.5)]',
  gradient: 'shadow-[0_0_10px_rgba(34,197,94,0.3)]',
}

const sizeStyles: Record<ProgressSize, string> = {
  sm: 'h-1.5',
  md: 'h-2',
  lg: 'h-3',
}

export function ProgressBar({
  value,
  max = 100,
  variant = 'accent',
  size = 'md',
  showLabel = false,
  label,
  animate = true,
  glow = false,
  className = '',
}: ProgressBarProps) {
  const [width, setWidth] = useState(animate ? 0 : (value / max) * 100)
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100)

  useEffect(() => {
    if (animate) {
      const timer = setTimeout(() => {
        setWidth(percentage)
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [animate, percentage])

  return (
    <div className={className}>
      {(showLabel || label) && (
        <div className="flex items-center justify-between mb-2">
          {label && <span className="text-sm text-text-secondary">{label}</span>}
          {showLabel && (
            <span className="text-sm font-medium text-text-primary tabular-nums">
              {percentage.toFixed(0)}%
            </span>
          )}
        </div>
      )}
      <div
        className={`
          w-full bg-surface-hover rounded-full overflow-hidden
          ${sizeStyles[size]}
        `}
      >
        <div
          className={`
            h-full rounded-full transition-all duration-500 ease-out-expo
            ${variantStyles[variant]}
            ${glow ? glowStyles[variant] : ''}
          `}
          style={{ width: `${animate ? width : percentage}%` }}
        />
      </div>
    </div>
  )
}

// =============================================================================
// DISTRIBUTION BAR - Shows multiple segments
// =============================================================================

interface DistributionSegment {
  value: number
  label: string
  color: 'accent' | 'blue' | 'purple' | 'orange' | 'gray'
}

interface DistributionBarProps {
  segments: DistributionSegment[]
  size?: ProgressSize
  showLegend?: boolean
  animate?: boolean
  className?: string
}

const segmentColors: Record<string, string> = {
  accent: 'bg-accent',
  blue: 'bg-accent-blue',
  purple: 'bg-accent-purple',
  orange: 'bg-accent-orange',
  gray: 'bg-text-muted',
}

const dotColors: Record<string, string> = {
  accent: 'bg-accent',
  blue: 'bg-accent-blue',
  purple: 'bg-accent-purple',
  orange: 'bg-accent-orange',
  gray: 'bg-text-muted',
}

export function DistributionBar({
  segments,
  size = 'md',
  showLegend = true,
  animate = true,
  className = '',
}: DistributionBarProps) {
  const [mounted, setMounted] = useState(!animate)
  const total = segments.reduce((sum, seg) => sum + seg.value, 0)

  useEffect(() => {
    if (animate) {
      const timer = setTimeout(() => setMounted(true), 100)
      return () => clearTimeout(timer)
    }
  }, [animate])

  return (
    <div className={className}>
      <div
        className={`
          w-full bg-surface-hover rounded-full overflow-hidden flex
          ${sizeStyles[size]}
        `}
      >
        {segments.map((segment, index) => {
          const width = total > 0 ? (segment.value / total) * 100 : 0
          return (
            <div
              key={segment.label}
              className={`
                h-full transition-all duration-500 ease-out-expo
                ${segmentColors[segment.color]}
                ${index === 0 ? 'rounded-l-full' : ''}
                ${index === segments.length - 1 ? 'rounded-r-full' : ''}
              `}
              style={{ width: mounted ? `${width}%` : '0%' }}
            />
          )
        })}
      </div>

      {showLegend && (
        <div className="flex flex-wrap gap-4 mt-3">
          {segments.map((segment) => (
            <div key={segment.label} className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${dotColors[segment.color]}`} />
              <span className="text-xs text-text-secondary">{segment.label}</span>
              <span className="text-xs font-medium text-text-primary tabular-nums">
                {segment.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// CIRCULAR PROGRESS
// =============================================================================

interface CircularProgressProps {
  value: number
  max?: number
  size?: number
  strokeWidth?: number
  variant?: ProgressVariant
  showValue?: boolean
  label?: string
}

export function CircularProgress({
  value,
  max = 100,
  size = 80,
  strokeWidth = 6,
  variant = 'accent',
  showValue = true,
  label,
}: CircularProgressProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100)
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (percentage / 100) * circumference

  const gradientId = `circular-gradient-${variant}`

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            {variant === 'accent' && (
              <>
                <stop offset="0%" stopColor="#22c55e" />
                <stop offset="100%" stopColor="#16a34a" />
              </>
            )}
            {variant === 'blue' && (
              <>
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#1d4ed8" />
              </>
            )}
            {variant === 'purple' && (
              <>
                <stop offset="0%" stopColor="#8b5cf6" />
                <stop offset="100%" stopColor="#6d28d9" />
              </>
            )}
            {variant === 'gradient' && (
              <>
                <stop offset="0%" stopColor="#22c55e" />
                <stop offset="50%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </>
            )}
          </linearGradient>
        </defs>
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-surface-hover"
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-500 ease-out-expo"
        />
      </svg>
      {(showValue || label) && (
        <div className="text-center mt-2">
          {showValue && (
            <div className="text-2xl font-bold text-text-primary tabular-nums">
              {percentage.toFixed(0)}%
            </div>
          )}
          {label && <div className="text-xs text-text-muted mt-0.5">{label}</div>}
        </div>
      )}
    </div>
  )
}
