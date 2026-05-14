import { ReactNode } from 'react'

// =============================================================================
// CARD VARIANTS
// =============================================================================

type CardVariant = 'default' | 'glass' | 'gradient-border' | 'elevated'

interface CardProps {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
  title?: string
  description?: string
  action?: ReactNode
  variant?: CardVariant
  hover?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

const variantStyles: Record<CardVariant, string> = {
  default: 'bg-surface border border-border',
  glass: 'backdrop-blur-xl',
  'gradient-border': 'bg-surface gradient-border',
  elevated: 'bg-surface-elevated border border-border shadow-card',
}

const variantInlineStyles: Record<CardVariant, React.CSSProperties> = {
  default: {},
  glass: { background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' },
  'gradient-border': {},
  elevated: {},
}

const paddingStyles = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
}

export function Card({
  children,
  className = '',
  style,
  title,
  description,
  action,
  variant = 'default',
  hover = true,
  padding = 'md',
}: CardProps) {
  const hoverStyles = hover
    ? 'transition-all duration-300 ease-out-expo hover:border-accent/30 hover:shadow-card-hover hover:-translate-y-0.5'
    : ''

  return (
    <div
      className={`
        rounded-xl
        ${variantStyles[variant]}
        ${paddingStyles[padding]}
        ${hoverStyles}
        ${className}
      `}
      style={{ ...variantInlineStyles[variant], ...style }}
    >
      {(title || description || action) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && (
              <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
            )}
            {description && (
              <p className="text-sm text-text-muted mt-1">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

// =============================================================================
// STAT CARD - Enhanced with animations and icons
// =============================================================================

interface StatCardProps {
  label: string
  value: string | number
  prefix?: string
  suffix?: string
  className?: string
  icon?: ReactNode
  trend?: {
    value: number
    isPositive: boolean
  }
  variant?: 'default' | 'accent' | 'blue' | 'purple' | 'orange'
  animate?: boolean
}

const statVariantStyles = {
  default: 'border-border hover:border-accent/30',
  accent: 'border-accent/20 bg-accent/5 hover:border-accent/40',
  blue: 'border-accent-blue/20 bg-accent-blue/5 hover:border-accent-blue/40',
  purple: 'border-accent-purple/20 bg-accent-purple/5 hover:border-accent-purple/40',
  orange: 'border-accent-orange/20 bg-accent-orange/5 hover:border-accent-orange/40',
}

const iconVariantStyles = {
  default: 'bg-surface-hover text-text-secondary',
  accent: 'bg-accent/10 text-accent',
  blue: 'bg-accent-blue/10 text-accent-blue',
  purple: 'bg-accent-purple/10 text-accent-purple',
  orange: 'bg-accent-orange/10 text-accent-orange',
}

export function StatCard({
  label,
  value,
  prefix,
  suffix,
  className = '',
  icon,
  trend,
  variant = 'default',
  animate = true,
}: StatCardProps) {
  return (
    // The grid-cols-6 layout on the Reports page can squeeze each card
    // down to ~170px. Grid items default to min-width: auto (won't
    // shrink below content), so we override with min-w-0 + overflow-hidden
    // here. Without this every truncate further down is a no-op.
    <div
      className={`
        min-w-0 overflow-hidden
        bg-surface border rounded-xl p-4 sm:p-6
        transition-all duration-300 ease-out-expo
        hover:shadow-card-hover hover:-translate-y-0.5
        ${statVariantStyles[variant]}
        ${animate ? 'animate-fade-in' : ''}
        ${className}
      `}
    >
      <div className="flex items-start justify-between mb-3 gap-2">
        <p className="text-xs text-text-muted uppercase tracking-wider font-medium min-w-0 truncate">
          {label}
        </p>
        {icon && (
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconVariantStyles[variant]}`}>
            {icon}
          </div>
        )}
      </div>

      {/* The value uses an inline clamp() so the font scales smoothly
          with the card width: 18px floor at the narrowest, 32px ceiling
          on big screens. Combined with truncate + min-w-0 the ellipsis
          still kicks in if even 18px is too wide. Inline style beats
          any Tailwind cache miss; this works in every browser the dash
          targets without waiting for the JIT to compile new classes. */}
      <div className="flex items-baseline gap-1 min-w-0">
        {prefix && (
          <span className="text-base sm:text-lg font-medium text-accent flex-shrink-0">{prefix}</span>
        )}
        <span
          className="block min-w-0 flex-1 truncate font-bold text-text-primary tabular-nums"
          style={{ fontSize: 'clamp(1.125rem, 2.2vw + 0.4rem, 2rem)', lineHeight: 1.15 }}
        >
          {value}
        </span>
        {suffix && (
          <span className="text-xs sm:text-sm text-text-muted ml-1 flex-shrink-0">{suffix}</span>
        )}
      </div>

      {trend && (
        <div className="mt-3 flex items-center gap-1.5">
          <span
            className={`
              inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full
              ${trend.isPositive
                ? 'bg-success/10 text-success'
                : 'bg-error/10 text-error'
              }
            `}
          >
            <svg
              className={`w-3 h-3 ${trend.isPositive ? '' : 'rotate-180'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 10l7-7m0 0l7 7m-7-7v18"
              />
            </svg>
            {Math.abs(trend.value)}%
          </span>
          <span className="text-xs text-text-muted">vs last period</span>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// METRIC CARD - Large display for key metrics
// =============================================================================

interface MetricCardProps {
  label: string
  value: string | number
  subtitle?: string
  icon?: ReactNode
  gradient?: 'accent' | 'blue' | 'purple' | 'mixed'
}

const gradientStyles = {
  accent: 'from-accent/20 to-transparent',
  blue: 'from-accent-blue/20 to-transparent',
  purple: 'from-accent-purple/20 to-transparent',
  mixed: 'from-accent/10 via-accent-blue/10 to-accent-purple/10',
}

export function MetricCard({
  label,
  value,
  subtitle,
  icon,
  gradient = 'accent',
}: MetricCardProps) {
  return (
    <div className="relative overflow-hidden bg-surface border border-border rounded-xl p-6 transition-all duration-300 hover:border-accent/30 hover:shadow-card-hover">
      {/* Gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradientStyles[gradient]} pointer-events-none`} />

      <div className="relative">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-text-muted font-medium">{label}</span>
          {icon && (
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent">
              {icon}
            </div>
          )}
        </div>

        <div className="text-4xl md:text-5xl font-bold text-text-primary mb-1">
          {value}
        </div>

        {subtitle && (
          <p className="text-sm text-text-muted">{subtitle}</p>
        )}
      </div>
    </div>
  )
}
