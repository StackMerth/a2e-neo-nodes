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
import { RefreshCw, type LucideIcon } from 'lucide-react'

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
            <p className="font-mono text-xs uppercase mt-1" style={{ color: 'var(--text-muted)', letterSpacing: '0.18em' }}>
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {liveLabel && (
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-accent/40 bg-accent/10">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              <span className="font-mono text-[11px] tracking-[0.18em]" style={{ color: 'var(--primary)' }}>
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
      className="rounded-md overflow-hidden border border-border"
      style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(20px)' }}
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

export function MetricCard({ label, value, detail, icon: Icon, tone = 'green' }: MetricCardData) {
  const colors = TONE_MAP[tone] ?? TONE_MAP.green
  return (
    <div
      className="rounded-md border border-border p-4 sm:p-5"
      style={{ background: 'var(--bg-elevated)' }}
    >
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
