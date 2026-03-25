interface CardProps {
  children: React.ReactNode
  className?: string
  title?: string
  description?: string
  action?: React.ReactNode
}

export function Card({ children, className = '', title, description, action }: CardProps) {
  return (
    <div className={`bg-surface border border-border rounded-xl p-6 ${className}`}>
      {(title || description || action) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h3 className="text-lg font-semibold text-text-primary">{title}</h3>}
            {description && <p className="text-sm text-text-muted mt-1">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string | number
  prefix?: string
  suffix?: string
  className?: string
}

export function StatCard({ label, value, prefix, suffix, className = '' }: StatCardProps) {
  return (
    <div className={`bg-surface border border-border rounded-xl p-6 text-center ${className}`}>
      <p className="text-xs text-text-muted uppercase tracking-wider mb-3">{label}</p>
      <p className="text-3xl md:text-4xl font-bold text-text-primary">
        {prefix && <span className="text-accent">{prefix}</span>}
        {value}
        {suffix && <span className="text-text-muted text-lg ml-1">{suffix}</span>}
      </p>
    </div>
  )
}
