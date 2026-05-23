'use client'

/*
 * Aggregated GPU rental grid. Renders one tile per GPU tier present
 * in stats.nodesByTier. The Rent button on each tile opens an auth
 * modal (sign in or quick sign up); once authenticated, the buyer is
 * redirected to user.tokenos.ai/buyer/request with the tier
 * pre-selected via query string.
 *
 * Auth tokens are passed cross-subdomain via a URL fragment ingested
 * by the portal's /auth/handoff route. Fragments aren't sent to the
 * server so the JWT stays client-side.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Cpu, X, Loader2, Eye, EyeOff } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'
const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://user.tokenos.ai'

// ---------------------------------------------------------------------
// GPU metadata. VRAM + architecture per tier so tiles can show the
// hardware identity beneath the tier code.
// ---------------------------------------------------------------------

const GPU_META: Record<string, { architecture: string; vram: string; accent: string }> = {
  H100:  { architecture: 'Hopper',    vram: '80GB HBM3',   accent: '#22c55e' },
  H200:  { architecture: 'Hopper',    vram: '141GB HBM3e', accent: '#3b82f6' },
  // L40S: Ada-Lovelace datacenter card; cyan accent keeps it distinct
  // from the consumer-tier teal cluster below.
  L40S:  { architecture: 'Ada Lovelace', vram: '48GB GDDR6', accent: '#06b6d4' },
  B200:  { architecture: 'Blackwell', vram: '192GB HBM3e', accent: '#8b5cf6' },
  B300:  { architecture: 'Blackwell Ultra', vram: '288GB HBM3e', accent: '#f59e0b' },
  GB300: { architecture: 'Grace Blackwell', vram: 'NVL72',  accent: '#ef4444' },
  // C2 wave 2: consumer / prosumer entries. Not rendered as primary
  // RentGrid tiles (those stay datacenter-only) but the RentModal
  // looks them up by key when a buyer rents from a consumer-tier
  // listing on /marketplace - without these entries the non-null
  // assert on GPU_META[tier] would crash the modal.
  RTX_4090: { architecture: 'Ada Lovelace', vram: '24GB GDDR6X', accent: '#14b8a6' },
  RTX_3090: { architecture: 'Ampere',       vram: '24GB GDDR6X', accent: '#14b8a6' },
  CONSUMER: { architecture: 'Consumer NVIDIA', vram: 'varies',   accent: '#14b8a6' },
}

const CONSUMER_TIERS = new Set<string>(['CONSUMER', 'RTX_4090', 'RTX_3090'])

interface StatsResponse {
  totalNodesOnline: number
  nodesByTier: Array<{ gpuTier: string; count: number }>
  topPricesByTier: Array<{ gpuTier: string; ratePerHour: number; ratePerMinute: number }>
}

interface AnalyticsResponse {
  rateHistory: Record<string, Array<{ date: string; ratePerHour: number }>>
  rateTable: Array<{ gpuTier: string; current: number; median30d: number; min30d: number; max30d: number }>
}

// ---------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------

export function RentGrid({ stats, analytics }: { stats: StatsResponse; analytics: AnalyticsResponse }) {
  const [openTier, setOpenTier] = useState<string | null>(null)

  // Render a tile for every tier that has metadata + appears in stats.
  // Tiers with zero idle nodes still render so buyers can see the
  // supply chip flip to Low/None.
  const tiers = (['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300'] as const).filter(t => GPU_META[t])

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {tiers.map(tier => {
          const count = stats.nodesByTier.find(t => t.gpuTier === tier)?.count ?? 0
          const price = stats.topPricesByTier.find(t => t.gpuTier === tier)?.ratePerHour ?? 0
          const history = analytics.rateHistory[tier] ?? []
          const rate = analytics.rateTable.find(t => t.gpuTier === tier)
          return (
            <RentTile
              key={tier}
              tier={tier}
              count={count}
              currentPrice={price}
              history={history.map(p => p.ratePerHour)}
              minPrice={rate?.min30d ?? price}
              maxPrice={rate?.max30d ?? price}
              onRent={() => setOpenTier(tier)}
            />
          )
        })}
      </div>

      {openTier && (
        <RentModal tier={openTier} onClose={() => setOpenTier(null)} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------

function RentTile({
  tier, count, currentPrice, history, minPrice, maxPrice, onRent,
}: {
  tier: string
  count: number
  currentPrice: number
  history: number[]
  minPrice: number
  maxPrice: number
  onRent: () => void
}) {
  const meta = GPU_META[tier]!
  const supply: { label: string; level: 0 | 1 | 2 | 3 } =
    count === 0 ? { label: 'None', level: 0 }
    : count < 5 ? { label: 'Low',  level: 1 }
    : count < 20 ? { label: 'Med', level: 2 }
    : { label: 'High', level: 3 }

  return (
    <div className="rounded-xl p-5 sm:p-6 bg-card border border-border flex flex-col gap-4 transition-colors hover:border-foreground/30">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-2xl text-foreground tracking-tight">
            {tier}
          </h2>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-sm"
              style={{
                background: `${meta.accent}22`,
                color: meta.accent,
                border: `1px solid ${meta.accent}55`,
              }}
            >
              {meta.architecture}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{meta.vram}</span>
          </div>
        </div>

        {/* Supply 3-dot indicator */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex items-center gap-0.5">
            {[1, 2, 3].map(i => (
              <span
                key={i}
                className="w-2 h-2 rounded-full"
                style={{
                  background: supply.level >= i ? '#22c55e' : 'var(--border)',
                }}
              />
            ))}
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {supply.label}
          </span>
        </div>
      </div>

      {/* Sparkline (always 80px tall so cards stay aligned even when
          a tier has no history yet). Stroke + fill in the tier's
          accent color so the chart reads as the GPU's identity. */}
      <div className="h-20" style={{ color: meta.accent }}>
        {history.length > 1 ? (
          <Sparkline values={history} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Not enough history yet
            </p>
          </div>
        )}
      </div>

      {/* Price + Rent CTA */}
      <div className="flex items-end justify-between gap-3 pt-1">
        <div>
          <p className="font-display text-3xl text-foreground leading-none">
            ${currentPrice.toFixed(2)}
            <span className="font-mono text-sm text-muted-foreground"> /hr</span>
          </p>
          <p className="font-mono text-[11px] text-muted-foreground mt-2">
            ${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)}/hr range
          </p>
        </div>
        <button
          type="button"
          onClick={onRent}
          disabled={count === 0}
          className="inline-flex items-center justify-center px-4 h-10 rounded-md font-mono text-xs uppercase tracking-[0.14em] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: count === 0 ? 'var(--muted)' : meta.accent,
            color: count === 0 ? 'var(--muted-foreground)' : '#0a0a0a',
          }}
        >
          {count === 0 ? 'No supply' : 'Rent'}
        </button>
      </div>

      {/* Operators link footer */}
      <a
        href={`/marketplace?gpuTier=${tier}`}
        className="font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {count > 0 ? `${count} ${count === 1 ? 'node' : 'nodes'} across operators` : 'No operators online'}
      </a>
    </div>
  )
}

// ---------------------------------------------------------------------
// Sparkline (inline SVG, color inherited from text)
// ---------------------------------------------------------------------

function Sparkline({ values, width = 320, height = 80 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(...values, 0.0001)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const step = width / Math.max(1, values.length - 1)
  const points = values.map((v, i) => {
    const x = i * step
    const y = height - ((v - min) / range) * (height - 6) - 3
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const area = `M0,${height} L${points.join(' L')} L${width},${height} Z`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" className="block">
      <path d={area} fill="currentColor" fillOpacity={0.15} />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------
// Auth modal
// ---------------------------------------------------------------------

type Tab = 'signin' | 'signup'

/**
 * Auth-and-handoff modal. Used both by RentGrid (with a tier only)
 * and by the operator profile + catalog pages (with tier + operator
 * slug) so the rental form lands with both preselected.
 */
export function RentModal({
  tier, operatorSlug, onClose,
}: {
  tier: string
  operatorSlug?: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const endpoint = tab === 'signin' ? '/v1/portal/auth/login' : '/v1/portal/auth/register'
      const body = tab === 'signin'
        ? { email: email.trim(), password }
        : { email: email.trim(), password, role: 'COMPUTE_BUYER' }
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = (data as { error?: string; message?: string }).error
          ?? (data as { message?: string }).message
          ?? `${res.status} ${res.statusText}`
        throw new Error(msg)
      }
      const json = (await res.json()) as {
        accessToken?: string
        refreshToken?: string
      }
      if (!json.accessToken || !json.refreshToken) {
        throw new Error('Auth response missing tokens')
      }
      // Hand off to portal: portal's /auth/handoff reads the fragment,
      // stores tokens in its own localStorage, then redirects to dest.
      // M5.10c: pass operator slug too when the modal was opened from
      // an operator-specific surface (profile / catalog / leaderboard).
      // C2 wave 2: consumer-tier rentals carry workloadType=INFERENCE so
      // the request page lands with the correct workload selected (the
      // tier card would render as locked otherwise).
      const destParts: string[] = [`gpuTier=${encodeURIComponent(tier)}`]
      if (operatorSlug) destParts.push(`operator=${encodeURIComponent(operatorSlug)}`)
      if (CONSUMER_TIERS.has(tier)) destParts.push('workloadType=INFERENCE')
      const dest = `/buyer/request?${destParts.join('&')}`
      const hash = new URLSearchParams({
        access: json.accessToken,
        refresh: json.refreshToken,
        dest,
      }).toString()
      window.location.href = `${PORTAL_URL}/auth/handoff#${hash}`
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
      setSubmitting(false)
    }
  }

  const meta = GPU_META[tier]!

  // C2 wave 2 bug fix: the marketplace ListingRow wraps its content
  // in a <Link href="/operator/...">. If we render the modal inline,
  // it lives inside the Link's DOM subtree, and clicks inside the
  // modal (eg focusing the email input) can bubble up to the anchor
  // and navigate the buyer to the operator profile mid-signup.
  // Rendering through a portal attaches the modal to document.body
  // so it's a sibling of the Link, not a descendant. SSR-safe via the
  // `typeof document` check; during the brief Next.js server pass we
  // render nothing — the modal was already client-gated by `open`.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-xl p-6 bg-card border border-border"
        style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 w-8 h-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
        >
          <X size={16} />
        </button>

        <div className="flex items-center gap-3 mb-1">
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
            style={{ background: `${meta.accent}22`, border: `1px solid ${meta.accent}55` }}
          >
            <Cpu size={16} style={{ color: meta.accent }} />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Renting
            </p>
            <p className="font-display text-lg text-foreground">{tier}</p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-5">
          Sign in or create a buyer account to continue. The rental wizard opens next with {tier} pre-selected
          {operatorSlug && (
            <> and <span className="font-mono text-foreground">{operatorSlug}</span> as your preferred operator</>
          )}.
        </p>

        {/* Tabs */}
        <div className="inline-flex rounded-full p-1 mb-4 border border-border" style={{ background: 'rgba(255,255,255,0.04)' }}>
          {([
            { id: 'signup',  label: 'Quick sign up' },
            { id: 'signin',  label: 'Sign in' },
          ] as Array<{ id: Tab; label: string }>).map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setTab(t.id); setError(null) }}
              className={`px-3 py-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
                tab === t.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/75'
              }`}
              style={tab === t.id ? {
                background: 'rgba(34,197,94,0.12)',
                boxShadow: 'inset 0 0 0 1px rgba(34,197,94,0.35)',
              } : undefined}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground block mb-1">
              Email
            </label>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:border-primary transition-colors"
              style={{
                background: 'var(--input)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
              }}
            />
          </div>
          <div>
            <label className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground block mb-1">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tab === 'signup' ? 'At least 8 characters' : 'Your password'}
                className="w-full px-3 py-2 pr-10 rounded-md text-sm focus:outline-none focus:border-primary transition-colors"
                style={{
                  background: 'var(--input)',
                  border: '1px solid var(--border)',
                  color: 'var(--foreground)',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs px-3 py-2 rounded-md" style={{ color: '#ef4444', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-md font-mono text-xs uppercase tracking-[0.16em] mt-1 transition-colors disabled:opacity-60"
            style={{ background: 'var(--primary)', color: '#0a0a0a' }}
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {tab === 'signin' ? 'Sign in and continue' : 'Create account and continue'}
          </button>

          <p className="text-[11px] text-muted-foreground text-center mt-2">
            By {tab === 'signin' ? 'signing in' : 'signing up'} you agree to the network rules. Wallet can be added later in settings; an email is enough for refunds and rental notifications.
          </p>
        </form>
      </div>
    </div>,
    document.body,
  )
}
