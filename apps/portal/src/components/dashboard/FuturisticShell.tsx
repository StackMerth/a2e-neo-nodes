'use client'

/*
 * NEXUS-OS-inspired dashboard atoms.
 *
 * Visual idiom borrowed from StackMerth/v0-futuristic-dashboard, retuned
 * to the TokenOS DeAI brand: sage-green (--primary, oklch 0.72/0.14/152)
 * instead of cyan, Inter Black for big numerics, JetBrains Mono for
 * labels. Card backgrounds use the existing --glass-bg token so dark
 * and light themes both look right out of the box.
 *
 * Shape:
 *
 *   <DashboardShell title=... liveLabel=... onRefresh=...>
 *     <DashboardMainColumn>
 *       <MetricTriad ... />
 *       <SectionCard title=...>
 *         ...
 *       </SectionCard>
 *     </DashboardMainColumn>
 *     <DashboardRightRail>
 *       <ClockCard />
 *       <QuickActions actions={[...]} />
 *       <ResourceAllocation bars={[...]} />
 *     </DashboardRightRail>
 *   </DashboardShell>
 */

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { RefreshCw, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'

/* ---------- Shell ---------- */

export function DashboardShell({
  title,
  subtitle,
  liveLabel,
  onRefresh,
  refreshing,
  children,
}: {
  title: string
  subtitle?: string
  liveLabel?: string
  onRefresh?: () => void
  refreshing?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 pb-4 border-b border-border">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl tracking-tight" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            {title}
          </h1>
          {subtitle && (
            <p className="font-mono text-[13px] uppercase mt-1.5" style={{ color: 'var(--text-muted)', letterSpacing: '0.16em' }}>
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {liveLabel && (
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-accent/40 bg-accent/10">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="font-mono text-[12px] tracking-[0.16em]" style={{ color: 'var(--primary)' }}>
                {liveLabel}
              </span>
            </span>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh"
              className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} style={{ color: 'var(--text-secondary)' }} />
            </button>
          )}
        </div>
      </div>

      {/* Main grid: 2/3 + 1/3 on lg, stacks on smaller screens */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {children}
      </div>
    </div>
  )
}

export function DashboardMainColumn({ children }: { children: ReactNode }) {
  return <div className="lg:col-span-2 flex flex-col gap-6">{children}</div>
}

export function DashboardRightRail({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6">{children}</div>
}

/* ---------- Section card ---------- */

export function SectionCard({
  title,
  icon: Icon,
  badge,
  actions,
  children,
  noPadding,
}: {
  title?: string
  icon?: LucideIcon
  badge?: ReactNode
  actions?: ReactNode
  children: ReactNode
  noPadding?: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-md overflow-hidden"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur, 24px))',
        WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0, 0, 0, 0.35))',
      }}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="w-5 h-5" style={{ color: 'var(--primary)' }} />}
            {title && (
              <h2 className="font-display text-base tracking-tight" style={{ color: 'var(--text-primary)' }}>
                {title}
              </h2>
            )}
            {badge}
          </div>
          {actions}
        </div>
      )}
      <div className={noPadding ? '' : 'p-5 sm:p-6'}>{children}</div>
    </motion.div>
  )
}

/* ---------- Metric triad (3 stat cards in a row) ---------- */

const TONE_MAP: Record<string, { bg: string; text: string; icon: string }> = {
  green:  { bg: 'rgba(34,197,94,0.12)',   text: '#22c55e', icon: '#16a34a' },
  cyan:   { bg: 'rgba(6,182,212,0.12)',   text: '#06b6d4', icon: '#06b6d4' },
  purple: { bg: 'rgba(139,92,246,0.12)',  text: '#a78bfa', icon: '#8b5cf6' },
  blue:   { bg: 'rgba(59,130,246,0.12)',  text: '#60a5fa', icon: '#3b82f6' },
  orange: { bg: 'rgba(249,115,22,0.12)',  text: '#fb923c', icon: '#f97316' },
  pink:   { bg: 'rgba(236,72,153,0.12)',  text: '#f472b6', icon: '#ec4899' },
}

export interface MetricCardData {
  label: string
  value: string | number
  detail?: string
  icon: LucideIcon
  tone?: keyof typeof TONE_MAP
  // Optional internal path. When set, the card renders as a Link and
  // shows a hover lift + cursor pointer to telegraph it's clickable.
  href?: string
}

export function MetricTriad({ metrics }: { metrics: MetricCardData[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {metrics.map((m) => (
        <MetricCard key={m.label} {...m} />
      ))}
    </div>
  )
}

export function MetricCard({ label, value, detail, icon: Icon, tone = 'green', href }: MetricCardData) {
  const colors = TONE_MAP[tone] ?? TONE_MAP.green
  const body = (
    <>
      <div className="flex items-start justify-between mb-3">
        <span className="font-mono text-[11px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span
          className="flex items-center justify-center w-8 h-8 rounded-md"
          style={{ background: colors.bg, color: colors.icon }}
        >
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div className="font-display text-3xl tracking-tight" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
        {value}
      </div>
      {detail && (
        <p className="font-mono text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
          {detail}
        </p>
      )}
    </>
  )

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-md border border-border p-4 sm:p-5 block transition-all hover:-translate-y-0.5 hover:border-foreground/30"
        style={{ background: 'var(--bg-elevated)' }}
      >
        {body}
      </Link>
    )
  }
  return (
    <div
      className="rounded-md border border-border p-4 sm:p-5"
      style={{ background: 'var(--bg-elevated)' }}
    >
      {body}
    </div>
  )
}

/* ---------- Right rail atoms ---------- */

export function ClockCard() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // SSR safety: render placeholders until mounted to avoid hydration mismatch.
  const timeStr = now ? now.toLocaleTimeString('en-US', { hour12: false }) : '00:00:00'
  const dateStr = now ? now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : ''

  return (
    <SectionCard noPadding>
      <div className="p-6 text-center">
        <p className="font-mono text-[11px] tracking-[0.18em] uppercase mb-3" style={{ color: 'var(--text-muted)' }}>
          System Time
        </p>
        <div className="font-display text-4xl tracking-tight mb-2" style={{ color: 'var(--primary)', letterSpacing: '-0.02em' }}>
          {timeStr}
        </div>
        <p className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }} suppressHydrationWarning>
          {dateStr}
        </p>
      </div>
    </SectionCard>
  )
}

export interface QuickActionData {
  label: string
  href: string
  icon: LucideIcon
  emphasis?: boolean
}

export function QuickActions({ actions }: { actions: QuickActionData[] }) {
  return (
    <SectionCard title="Quick Actions">
      <div className="grid grid-cols-2 gap-3">
        {actions.map((a) => (
          <Link
            key={a.label}
            href={a.href}
            className={`flex flex-col items-center justify-center gap-2 h-20 rounded-md border transition-colors ${
              a.emphasis
                ? 'border-accent/40 bg-accent/10 hover:bg-accent/20 text-accent'
                : 'border-border hover:bg-surface-hover'
            }`}
          >
            <a.icon className="w-4 h-4" />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em]">{a.label}</span>
          </Link>
        ))}
      </div>
    </SectionCard>
  )
}

/* ---------- Resource allocation bars ---------- */

export interface ResourceBarData {
  label: string
  value: number
  max?: number
  // Display tone for the gradient fill. Freestyle palette.
  tone?: 'green' | 'cyan' | 'purple' | 'blue' | 'orange' | 'pink'
  detail?: string
}

const BAR_GRADIENT: Record<NonNullable<ResourceBarData['tone']>, string> = {
  green:  'linear-gradient(90deg, #16a34a 0%, #22c55e 60%, #4ade80 100%)',
  cyan:   'linear-gradient(90deg, #0891b2 0%, #06b6d4 60%, #22d3ee 100%)',
  purple: 'linear-gradient(90deg, #7c3aed 0%, #8b5cf6 60%, #a78bfa 100%)',
  blue:   'linear-gradient(90deg, #2563eb 0%, #3b82f6 60%, #60a5fa 100%)',
  orange: 'linear-gradient(90deg, #ea580c 0%, #f97316 60%, #fb923c 100%)',
  pink:   'linear-gradient(90deg, #db2777 0%, #ec4899 60%, #f472b6 100%)',
}

export function ResourceAllocation({
  title = 'Resource Allocation',
  bars,
}: {
  title?: string
  bars: ResourceBarData[]
}) {
  return (
    <SectionCard title={title}>
      <div className="space-y-5">
        {bars.map((b) => {
          const max = b.max ?? 100
          const pct = Math.min(100, Math.max(0, (b.value / max) * 100))
          return (
            <div key={b.label}>
              <div className="flex items-baseline justify-between mb-2">
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-secondary)' }}>
                  {b.label}
                </span>
                <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>
                  {b.detail ?? `${pct.toFixed(0)}%`}
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                <div
                  className="h-full rounded-full transition-[width] duration-700 ease-out"
                  style={{ width: `${pct}%`, background: BAR_GRADIENT[b.tone ?? 'green'] }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

/* ---------- DataTableCard ---------- */
/*
 * SectionCard wrapping a styled table. Use when the page is dominated
 * by a paginated list (jobs, payouts, audit, etc.). Pass columns and
 * rows; the table renders sticky head, hover rows, mono numerics, and
 * an optional pagination footer. For free-form cells provide `render`
 * on the column; for primitive values the column reads `row[key]`.
 */

export interface DataTableColumn<Row> {
  key: keyof Row & string
  header: ReactNode
  align?: 'left' | 'right' | 'center'
  /** Render mono-spaced for numerics, ids, hashes. */
  mono?: boolean
  /** Override the cell renderer (defaults to row[key] as string). */
  render?: (row: Row, idx: number) => ReactNode
  /** Optional width hint (px, %, or tailwind class). */
  width?: string
}

export interface PaginationState {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export function DataTableCard<Row extends Record<string, unknown>>({
  title,
  icon,
  badge,
  actions,
  columns,
  rows,
  rowKey,
  loading,
  empty,
  pagination,
  onRowClick,
}: {
  title?: string
  icon?: LucideIcon
  badge?: ReactNode
  actions?: ReactNode
  columns: Array<DataTableColumn<Row>>
  rows: Row[]
  /** Function returning a stable key for each row. Defaults to row.id. */
  rowKey?: (row: Row, idx: number) => string | number
  loading?: boolean
  /** Renderer for the empty state when rows.length === 0. */
  empty?: ReactNode
  pagination?: PaginationState
  /** If provided, rows render as buttons and fire this on click. */
  onRowClick?: (row: Row) => void
}) {
  const keyFn = rowKey ?? ((row: Row, idx: number) =>
    (row.id as string | number | undefined) ?? idx)

  return (
    <SectionCard title={title} icon={icon} badge={badge} actions={actions} noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b border-border-subtle"
              style={{ background: 'rgba(255, 255, 255, 0.02)' }}
            >
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em]"
                  style={{
                    color: 'var(--text-muted)',
                    textAlign: c.align ?? 'left',
                    width: c.width,
                  }}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-5 py-10 text-center font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-5 py-10">
                  {empty ?? (
                    <p className="text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                      No records to show.
                    </p>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => {
                const k = keyFn(row, idx)
                const clickable = !!onRowClick
                return (
                  <tr
                    key={k}
                    className={`border-b border-border-subtle transition-colors ${clickable ? 'cursor-pointer hover:bg-surface-hover' : ''}`}
                    onClick={clickable ? () => onRowClick(row) : undefined}
                  >
                    {columns.map((c) => {
                      const cell = c.render ? c.render(row, idx) : (row[c.key] as ReactNode)
                      return (
                        <td
                          key={c.key}
                          className={`px-5 py-3 ${c.mono ? 'font-mono text-xs' : ''}`}
                          style={{
                            color: 'var(--text-primary)',
                            textAlign: c.align ?? 'left',
                          }}
                        >
                          {cell}
                        </td>
                      )
                    })}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination && pagination.total > pagination.pageSize && (
        <Pagination {...pagination} />
      )}
    </SectionCard>
  )
}

/* ---------- Pagination ---------- */

export function Pagination({ page, pageSize, total, onPageChange }: PaginationState) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return (
    <div
      className="flex items-center justify-between px-5 py-3 border-t border-border-subtle"
      style={{ background: 'rgba(255, 255, 255, 0.02)' }}
    >
      <p className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {start}–{end} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label="Previous page"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
        </button>
        <span className="font-mono text-[11px] px-3" style={{ color: 'var(--text-primary)' }}>
          {page} / {pages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(pages, page + 1))}
          disabled={page >= pages}
          aria-label="Next page"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
        </button>
      </div>
    </div>
  )
}

/* ---------- EmptyState ---------- */
/*
 * Helper for the `empty` slot on DataTableCard or any other panel that
 * needs an "no records yet" hero. Keeps the visual consistent.
 */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      {Icon && (
        <div
          className="w-12 h-12 rounded-full inline-flex items-center justify-center mb-4"
          style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid var(--border-color)' }}
        >
          <Icon className="w-6 h-6" style={{ color: 'var(--text-muted)' }} />
        </div>
      )}
      <h3 className="font-display text-lg mb-1" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h3>
      {description && (
        <p className="text-sm max-w-sm" style={{ color: 'var(--text-secondary)' }}>
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/* ---------- FormCard + FormSection ---------- */
/*
 * SectionCard tuned for forms. Header carries the title + optional
 * description + optional right-side actions (e.g. a Save button when
 * the form is short). Body is the form fields. Footer slot positions a
 * full-width action bar at the bottom for longer forms.
 *
 * Use `FormSection` to group related fields with a consistent gap.
 */

export function FormCard({
  title,
  description,
  icon,
  actions,
  footer,
  children,
}: {
  title: string
  description?: string
  icon?: LucideIcon
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-md overflow-hidden"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur, 24px))',
        WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
        border: '1px solid var(--glass-border)',
        boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0, 0, 0, 0.35))',
      }}
    >
      <div className="flex items-start justify-between px-5 sm:px-6 py-4 border-b border-border-subtle gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {icon && (
            <div className="shrink-0 mt-0.5">
              {(() => {
                const Icon = icon
                return <Icon className="w-5 h-5" style={{ color: 'var(--primary)' }} />
              })()}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="font-display text-base tracking-tight" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h2>
            {description && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="p-5 sm:p-6 space-y-6">{children}</div>
      {footer && (
        <div
          className="flex items-center justify-end gap-3 px-5 sm:px-6 py-4 border-t border-border-subtle"
          style={{ background: 'rgba(255, 255, 255, 0.02)' }}
        >
          {footer}
        </div>
      )}
    </motion.div>
  )
}

export function FormSection({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children: ReactNode
}) {
  return (
    <div>
      {(title || description) && (
        <div className="mb-3">
          {title && (
            <h3 className="font-mono text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
              {title}
            </h3>
          )}
          {description && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {description}
            </p>
          )}
        </div>
      )}
      <div className="space-y-4">{children}</div>
    </div>
  )
}
