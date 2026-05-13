'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Server,
  Copy,
  Check,
  Clock,
  Terminal,
  XCircle,
  DollarSign,
  Save,
} from 'lucide-react'
import { buyer } from '@/lib/api'
import { useWebSocket } from '@/hooks/useWebSocket'
import Link from 'next/link'
import {
  DashboardShell,
  SectionCard,
  EmptyState,
} from '@/components/dashboard/FuturisticShell'

interface ActiveAllocation {
  id: string
  requestId: string
  gpuTier: string
  gpuCount: number
  // M3: pricing tier (ON_DEMAND default | SPOT | RESERVED). Surfaced on
  // the card so buyers know which terms apply to each rental.
  tier?: 'ON_DEMAND' | 'SPOT' | 'RESERVED'
  commitmentDays?: number | null
  // M3: adminNote is parsed for 'PREEMPT_AT:<iso>|...' so the countdown
  // banner can render on page load (e.g. after refresh) without relying
  // on the live WS event having fired during this session.
  adminNote?: string | null
  // SSH connection details. sshHost is null for seed/test nodes (no
  // real datacenter machine behind them). sshUsername is the unix
  // account the agent creates per session. The credential is either
  // sshSessionToken (M2 ephemeral) or sshPassword (legacy/Phase 1).
  sshHost: string | null
  sshPort: number | null
  sshUsername: string | null
  sshPassword?: string | null
  sshSessionToken?: string | null
  sshSessionTokenExpiresAt?: string | null
  activatedAt: string
  expiresAt: string
  totalCost?: number
  accruedCost?: number
  minutesUsed?: number
  ratePerMinute?: number
  allocatedNodeIds?: string[]
  // M5.8 / D3: estimated grams of CO2 emitted by this rental so far,
  // recomputed each meter tick from (gpuTier TDP, gpuCount,
  // minutesUsed, region grid intensity). Surfaced on the card with the
  // formula footnote linked from /buyer/billing.
  co2Grams?: number | null
}

interface TickPayload {
  requestId: string
  minutesUsed: number
  accruedCost: number
  remainingCost: number
  co2Grams?: number
}

// M3: SPOT preemption notice. Fired by the spot-preemption worker when
// a SPOT rental is scheduled for eviction with a 90-second grace window.
interface PreemptionPayload {
  requestId: string
  preemptAt: string
  graceMs: number
  reason: string
}

const TIER_COLORS: Record<string, string> = {
  H100: '#22c55e',
  H200: '#3b82f6',
  B200: '#8b5cf6',
  B300: '#f59e0b',
  GB300: '#ef4444',
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-2 p-1 rounded transition-colors hover:bg-white/10"
      title="Copy to clipboard"
    >
      {copied ? <Check size={14} style={{ color: 'var(--primary)' }} /> : <Copy size={14} style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

function TimeRemainingBar({ expiresAt, activatedAt }: { expiresAt: string; activatedAt: string }) {
  const [progress, setProgress] = useState(0)
  const [label, setLabel] = useState('')

  useEffect(() => {
    const update = () => {
      const now = Date.now()
      const start = new Date(activatedAt).getTime()
      const end = new Date(expiresAt).getTime()
      const total = end - start
      const elapsed = now - start
      const pct = Math.min(100, Math.max(0, (elapsed / total) * 100))
      setProgress(pct)

      const remaining = end - now
      if (remaining <= 0) {
        setLabel('Expired')
        return
      }
      const days = Math.floor(remaining / 86400000)
      const hours = Math.floor((remaining % 86400000) / 3600000)
      setLabel(`${days}d ${hours}h remaining`)
    }
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [expiresAt, activatedAt])

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Time Used</span>
        <span className="text-xs font-medium" style={{ color: 'var(--primary)' }}>{label}</span>
      </div>
      <div className="w-full h-2 rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
        <div
          className="h-2 rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, background: 'var(--primary)' }}
        />
      </div>
    </div>
  )
}

// M3: SPOT preemption banner — full-width red strip across the top of
// an affected rental card. Live countdown to the eviction time.
function PreemptionBanner({ preemption }: { preemption: PreemptionPayload }) {
  const [secondsLeft, setSecondsLeft] = useState(0)
  useEffect(() => {
    const update = () => {
      const ms = new Date(preemption.preemptAt).getTime() - Date.now()
      setSecondsLeft(Math.max(0, Math.ceil(ms / 1000)))
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [preemption.preemptAt])

  return (
    <div
      className="rounded-lg p-3 mb-4 flex items-center gap-3"
      style={{
        background: 'rgba(239, 68, 68, 0.12)',
        border: '1px solid rgba(239, 68, 68, 0.4)',
      }}
    >
      <XCircle size={18} style={{ color: '#ef4444' }} />
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: '#ef4444' }}>
          SPOT preemption in {secondsLeft}s
        </p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Capacity needed for On-Demand demand. Save your work now. Unused minutes will be refunded.
        </p>
      </div>
    </div>
  )
}

export default function ActiveComputePage() {
  const [allocations, setAllocations] = useState<ActiveAllocation[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [terminatingId, setTerminatingId] = useState<string | null>(null)
  // Live tick state, keyed by request id. Updated on each compute:tick
  // websocket event (every 60s from the API meter). Clearing an entry
  // means we fall back to the value from the last loadData() pull.
  const [ticks, setTicks] = useState<Record<string, TickPayload>>({})
  // M3: preemption notices, keyed by request id. Set when worker emits
  // 'compute:preemption-notice' (90s before terminating a SPOT victim).
  // Cleared when terminate event fires.
  const [preemptions, setPreemptions] = useState<Record<string, PreemptionPayload>>({})

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const data = (await buyer.activeCompute()) as { allocations: ActiveAllocation[] }
      setAllocations(data.allocations ?? [])
    } catch {
      /* silently fail */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(() => loadData(), 30_000)
    return () => clearInterval(interval)
  }, [loadData])

  const wsEvents = useMemo(() => ({
    'compute:tick': (data: unknown) => {
      const payload = data as TickPayload
      if (!payload?.requestId) return
      setTicks(prev => ({ ...prev, [payload.requestId]: payload }))
    },
    'compute:terminated': (data: unknown) => {
      const payload = data as { requestId: string }
      if (!payload?.requestId) return
      // Drop the row immediately for responsive UI; refetch confirms.
      setAllocations(prev => prev.filter(a => a.id !== payload.requestId && a.requestId !== payload.requestId))
      // Clear any preemption notice (the rental is gone now)
      setPreemptions(prev => {
        const next = { ...prev }
        delete next[payload.requestId]
        return next
      })
      void loadData()
    },
    // M3: SPOT preemption — show countdown banner on the affected card
    'compute:preemption-notice': (data: unknown) => {
      const payload = data as PreemptionPayload
      if (!payload?.requestId) return
      setPreemptions(prev => ({ ...prev, [payload.requestId]: payload }))
    },
  }), [loadData])

  useWebSocket({ events: wsEvents })

  const handleTerminate = async (alloc: ActiveAllocation) => {
    const tick = ticks[alloc.id] ?? ticks[alloc.requestId]
    const accrued = tick?.accruedCost ?? alloc.accruedCost ?? 0
    const refund = Math.max(0, (alloc.totalCost ?? 0) - accrued)
    const ok = window.confirm(
      `Terminate this rental now?\n\n` +
      `Accrued so far: $${accrued.toFixed(2)}\n` +
      `Refund estimate: $${refund.toFixed(2)}\n\n` +
      `Refund will be sent to the wallet on your account settings.`,
    )
    if (!ok) return
    setTerminatingId(alloc.id)
    try {
      await buyer.terminateRequest(alloc.id)
      // The compute:terminated websocket event drives the UI update.
      // If the socket is offline, also refresh manually.
      void loadData()
    } catch (err) {
      window.alert(`Termination failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setTerminatingId(null)
    }
  }

  return (
    <DashboardShell
      title="Active Rentals"
      subtitle="GPU allocations currently running on your account"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3">
        <SectionCard title="Active Rentals" icon={Server}>
          {loading ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading rentals...</p>
          ) : allocations.length === 0 ? (
            <EmptyState
              icon={Server}
              title="No active compute"
              description="Your active GPU allocations will appear here once provisioned."
              action={
                <Link
                  href="/buyer/request"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium"
                  style={{ background: 'var(--primary)', color: '#fff' }}
                >
                  Request Compute
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {allocations.map((alloc) => {
                const tierColor = TIER_COLORS[alloc.gpuTier] ?? 'var(--primary)'
                const tick = ticks[alloc.id] ?? ticks[alloc.requestId]
                const accruedCost = tick?.accruedCost ?? alloc.accruedCost ?? 0
                const totalCost = alloc.totalCost ?? 0
                const remainingCost = Math.max(0, totalCost - accruedCost)
                const minutesUsed = tick?.minutesUsed ?? alloc.minutesUsed ?? 0
                // M5.8 / D3: live CO2 grams. Prefer the websocket tick, fall
                // back to whatever the rental row had when we last fetched.
                const co2Grams = tick?.co2Grams ?? alloc.co2Grams ?? null
                // M3: preemption notice for this card. Source priority:
                //   1. Live WS event (if received during this session)
                //   2. adminNote on the row parsed for 'PREEMPT_AT:<iso>|...'
                //      (handles page-refresh + missed WS event scenarios)
                const wsPreemption = preemptions[alloc.id] ?? preemptions[alloc.requestId]
                let preemption: PreemptionPayload | undefined = wsPreemption
                if (!preemption && alloc.adminNote?.startsWith('PREEMPT_AT:')) {
                  const isoEnd = alloc.adminNote.slice('PREEMPT_AT:'.length).split('|')[0]
                  const preemptAt = new Date(isoEnd ?? '')
                  if (!Number.isNaN(preemptAt.getTime()) && preemptAt > new Date()) {
                    preemption = {
                      requestId: alloc.id,
                      preemptAt: preemptAt.toISOString(),
                      graceMs: Math.max(0, preemptAt.getTime() - Date.now()),
                      reason: alloc.adminNote.split('|reason=')[1] ?? 'unknown',
                    }
                  }
                }
                return (
                  <div
                    key={alloc.id}
                    className="rounded-xl p-6"
                    style={{
                      background: 'var(--bg-elevated)',
                      border: `1px solid ${tierColor}30`,
                    }}
                  >
                    {/* M3: SPOT preemption banner — appears when this card's
                        rental has been scheduled for eviction. Shows a live
                        countdown so the buyer knows exactly when to save work. */}
                    {preemption && (
                      <PreemptionBanner preemption={preemption} />
                    )}

                    {/* Header Row */}
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span
                          className="text-xs font-bold px-3 py-1.5 rounded-lg"
                          style={{ background: `${tierColor}20`, color: tierColor }}
                        >
                          {alloc.gpuTier}
                        </span>
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          x{alloc.gpuCount} GPU{alloc.gpuCount > 1 ? 's' : ''}
                        </span>
                        {/* M3: pricing tier badge — distinguishes SPOT (yellow,
                            preemptible) from RESERVED (blue, committed) from
                            ON_DEMAND (green, default). */}
                        {alloc.tier && alloc.tier !== 'ON_DEMAND' && (
                          <span
                            className="text-xs font-bold px-2 py-1 rounded"
                            style={
                              alloc.tier === 'SPOT'
                                ? { background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.4)' }
                                : { background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.4)' }
                            }
                            title={
                              alloc.tier === 'SPOT'
                                ? 'Spot tier — 40% off, preemptible with 90s notice'
                                : `Reserved ${alloc.commitmentDays ?? ''}d — committed capacity, exempt from preemption`
                            }
                          >
                            {alloc.tier === 'SPOT'
                              ? 'SPOT'
                              : `RESERVED${alloc.commitmentDays ? ` ${alloc.commitmentDays}d` : ''}`}
                          </span>
                        )}
                        {alloc.tier === 'ON_DEMAND' && (
                          <span
                            className="text-xs font-bold px-2 py-1 rounded"
                            style={{ background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e', border: '1px solid rgba(34, 197, 94, 0.35)' }}
                            title="On-Demand — full price, never preempted"
                          >
                            ON-DEMAND
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        <Clock size={12} />
                        Expires {new Date(alloc.expiresAt).toLocaleDateString()}
                      </div>
                    </div>

                    {/* Time Remaining Progress Bar */}
                    <div className="mb-4">
                      <TimeRemainingBar expiresAt={alloc.expiresAt} activatedAt={alloc.activatedAt} />
                    </div>

                    {/* Live cost ticker (updated via compute:tick websocket event) */}
                    {totalCost > 0 && (
                      <div
                        className="rounded-lg p-3 mb-4 flex items-center justify-between"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
                      >
                        <div className="flex items-center gap-2">
                          <DollarSign size={14} style={{ color: tierColor }} />
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {minutesUsed} min used
                          </span>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                            ${accruedCost.toFixed(2)}
                            <span className="text-xs ml-1" style={{ color: 'var(--text-muted)' }}>
                              / ${totalCost.toFixed(2)}
                            </span>
                          </div>
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            ${remainingCost.toFixed(2)} refund if terminated now
                          </div>
                        </div>
                      </div>
                    )}

                    {/* M5.8 / D3: CO2 estimate per rental. Honest
                        approximation from GPU TDP times region grid
                        intensity. Formula footnoted on the billing page. */}
                    {co2Grams != null && co2Grams > 0 && (
                      <div
                        className="rounded-lg p-3 mb-4 flex items-center justify-between"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
                      >
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Carbon emitted (estimate)
                        </span>
                        <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                          {co2Grams >= 1000
                            ? `${(co2Grams / 1000).toFixed(2)} kg CO2`
                            : `${co2Grams.toFixed(0)} g CO2`}
                        </span>
                      </div>
                    )}

                    {/* SSH Details */}
                    {(() => {
                      const sshHost = alloc.sshHost ?? null
                      const sshPort = alloc.sshPort ?? 22
                      const sshUsername = alloc.sshUsername ?? 'a2e-buyer'
                      const sshCredential = alloc.sshSessionToken ?? alloc.sshPassword ?? null
                      const credentialLabel = alloc.sshSessionToken ? 'Session Token' : 'Password'
                      const isTestMode =
                        !sshHost ||
                        (alloc.allocatedNodeIds ?? []).some(id => id.startsWith('seed-node-'))

                      return (
                        <div
                          className="rounded-lg p-4"
                          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
                        >
                          <div className="flex items-center gap-2 mb-3">
                            <Terminal size={14} style={{ color: tierColor }} />
                            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                              SSH Access
                            </span>
                          </div>

                          {/* Test-mode banner — shown when the rental was assigned
                              to a seed-node or has no real host. The session token
                              is real and the rest of the M2 lifecycle (meter,
                              terminate, refund, expiry) all work; the only missing
                              piece is a real datacenter machine to connect to. */}
                          {isTestMode && (
                            <div
                              className="rounded-md p-3 mb-3 text-xs"
                              style={{
                                background: 'rgba(245, 158, 11, 0.1)',
                                border: '1px solid rgba(245, 158, 11, 0.3)',
                                color: 'var(--warning, #f59e0b)',
                              }}
                            >
                              <strong>Test mode rental.</strong> This rental was assigned to a
                              test/seed node, the SSH credentials below are real and
                              ephemeral, but there&rsquo;s no live GPU machine behind this host.
                              Real production rentals connect to actual datacenter hardware.
                            </div>
                          )}

                          <div className="space-y-2">
                            <div className="flex items-center text-xs">
                              <span style={{ color: 'var(--text-muted)', minWidth: 100 }}>Host</span>
                              <span className="font-mono" style={{ color: 'var(--text-primary)' }}>
                                {sshHost ?? <em style={{ color: 'var(--text-muted)' }}>not assigned (test node)</em>}
                              </span>
                              {sshHost && <CopyButton text={sshHost} />}
                            </div>
                            <div className="flex items-center text-xs">
                              <span style={{ color: 'var(--text-muted)', minWidth: 100 }}>Port</span>
                              <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{sshPort}</span>
                              <CopyButton text={String(sshPort)} />
                            </div>
                            <div className="flex items-center text-xs">
                              <span style={{ color: 'var(--text-muted)', minWidth: 100 }}>Username</span>
                              <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{sshUsername}</span>
                              <CopyButton text={sshUsername} />
                            </div>
                            {sshCredential && (
                              <div className="flex items-center text-xs">
                                <span style={{ color: 'var(--text-muted)', minWidth: 100 }}>{credentialLabel}</span>
                                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{'*'.repeat(12)}</span>
                                <CopyButton text={sshCredential} />
                              </div>
                            )}
                          </div>

                          {sshHost && (
                            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-color)' }}>
                              <div className="flex items-center text-xs">
                                <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                                  ssh {sshUsername}@{sshHost} -p {sshPort}
                                </span>
                                <CopyButton text={`ssh ${sshUsername}@${sshHost} -p ${sshPort}`} />
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* M3: Checkpoint button — triggers workspace snapshot.
                        Less prominent than Terminate (smaller, neutral color).
                        The actual S3 upload happens agent-side; the API just
                        flags REQUESTED for the agent to pick up. */}
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await buyer.checkpoint(alloc.id)
                            // toast wired via parent; for simplicity just alert here
                            window.alert('Checkpoint requested. Agent will package + upload your workspace shortly.')
                          } catch (err) {
                            window.alert(err instanceof Error ? err.message : 'Checkpoint failed')
                          }
                        }}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                        style={{
                          background: 'rgba(59, 130, 246, 0.1)',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          color: '#3b82f6',
                        }}
                      >
                        <Save size={14} />
                        Checkpoint Workspace
                      </button>
                      <p className="text-xs text-center mt-2" style={{ color: 'var(--text-muted)' }}>
                        Snapshot your workspace so you can restore it on a future rental.
                      </p>
                    </div>

                    {/* Terminate — full-width destructive CTA so buyers never
                        have to hunt for it. Red border + red text on the
                        darker neutral background calls attention without being
                        so loud it gets accidental clicks (we still have a
                        browser confirm dialog as the second guard). */}
                    <div className="mt-5">
                      <button
                        type="button"
                        onClick={() => handleTerminate(alloc)}
                        disabled={terminatingId === alloc.id}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all"
                        style={{
                          background: terminatingId === alloc.id
                            ? 'rgba(239, 68, 68, 0.05)'
                            : 'rgba(239, 68, 68, 0.1)',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          color: '#ef4444',
                          opacity: terminatingId === alloc.id ? 0.6 : 1,
                          cursor: terminatingId === alloc.id ? 'not-allowed' : 'pointer',
                        }}
                        onMouseEnter={(e) => {
                          if (terminatingId !== alloc.id) {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.18)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (terminatingId !== alloc.id) {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'
                          }
                        }}
                      >
                        <XCircle size={16} />
                        {terminatingId === alloc.id ? 'Terminating...' : 'Terminate Rental'}
                      </button>
                      <p className="text-xs text-center mt-2" style={{ color: 'var(--text-muted)' }}>
                        Refund any unused time. Returns ${remainingCost.toFixed(2)} to your wallet.
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>
    </DashboardShell>
  )
}
