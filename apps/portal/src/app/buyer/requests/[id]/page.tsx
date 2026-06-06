'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useWebSocket } from '@/hooks/useWebSocket'
import {
  ArrowLeft,
  Server,
  Clock,
  DollarSign,
  Copy,
  Check,
  FileText,
  Terminal,
  XCircle,
  Download,
  Star,
  Shield,
  Zap,
  Cloud,
  Loader2,
  Eye,
  EyeOff,
} from 'lucide-react'
import { buyer } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
} from '@/components/dashboard/FuturisticShell'

interface ComputeRequestDetail {
  id: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  ratePerDay: number
  totalCost: number
  status: string
  purpose?: string
  txHash: string
  requestedAt: string
  approvedAt?: string
  allocatedAt?: string
  activatedAt?: string
  completedAt?: string
  expiresAt?: string
  // Allocator-set flags that explain WHY a PENDING request is sitting
  // there. SEARCHING_CAPACITY = probing every 10s, no admin action
  // needed; NO_REGION_CAPACITY = constrained by requiredRegion; the
  // HOLD_* family only fires when status is WAITLISTED. Drives the
  // header banner copy so we don't lie about "admin team is reviewing"
  // when actually the queue is searching for stock.
  eligibilityFlags?: string[]
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  sshPassword?: string
  // M3-T7: pricing tier — drives the preemption-exempt vs preemptible
  // badge near the title. ON_DEMAND is default and gets a green badge,
  // SPOT yellow (preemptible), RESERVED blue (committed + exempt).
  tier?: 'ON_DEMAND' | 'SPOT' | 'RESERVED'
  commitmentDays?: number | null
  // M3-T5: adminNote carries the PREEMPT_AT:<iso> marker that the
  // spot-preemption worker writes when scheduling eviction. Used as a
  // fallback when the WS event was missed (e.g. page reload after the
  // notice fired). Parsed client-side in the page render to seed the
  // countdown banner.
  adminNote?: string | null
}

// M3-T5: SPOT preemption notice payload. Mirrors the WS event shape
// from the spot-preemption worker. graceMs is the original 90s window
// at the time the notice was emitted; the live countdown computes
// remaining time from (preemptAt - now) instead so it stays accurate
// across refreshes and timezone weirdness.
interface PreemptionPayload {
  requestId: string
  preemptAt: string
  graceMs: number
  reason: string
}

// M3-T5: live countdown banner — full-width red strip across the top
// of the detail page during a SPOT preemption grace window. Ticks
// every second. Auto-disappears when status flips to COMPLETED
// (handled by the parent's data refresh on compute:terminated).
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
      className="rounded-lg p-4 flex items-center gap-3"
      style={{
        background: 'rgba(239, 68, 68, 0.12)',
        border: '1px solid rgba(239, 68, 68, 0.4)',
      }}
    >
      <XCircle size={20} style={{ color: '#ef4444', flexShrink: 0 }} />
      <div className="flex-1">
        <p className="text-base font-semibold" style={{ color: '#ef4444' }}>
          SPOT preemption in {secondsLeft}s
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          Capacity needed for On-Demand demand. Save your work now. Unused minutes will be refunded.
        </p>
      </div>
    </div>
  )
}

const STEPS = ['PENDING', 'APPROVED', 'ALLOCATED', 'ACTIVE', 'COMPLETED'] as const

const STEP_LABELS: Record<string, string> = {
  PENDING: 'Requested',
  APPROVED: 'Approved',
  ALLOCATED: 'Allocated',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
}

const STATUS_MESSAGES: Record<string, { title: string; desc: string; color: string }> = {
  PENDING: { title: 'Looking for available capacity', desc: 'Checking suppliers every 10 seconds for a matching GPU. Provisioning starts the moment one is available. No action needed.', color: '#f59e0b' },
  APPROVED: { title: 'Request Approved', desc: 'Your request has been approved and resources are being prepared.', color: '#3b82f6' },
  ALLOCATED: { title: 'Resources Allocated', desc: 'GPUs have been allocated and are being configured for you.', color: '#8b5cf6' },
  ACTIVE: { title: 'Active, Connect via SSH', desc: 'Your compute resources are ready. Use the SSH details below to connect.', color: '#22c55e' },
  // External provider intermediate state. The page polls every 5s
  // for credentials while this is shown. Underlying supplier is
  // intentionally abstracted — buyers see "TokenOS Compute" so the
  // platform reads as a unified service, not a router into named
  // third-party clouds.
  PROVISIONING_EXTERNAL: { title: 'Provisioning your compute', desc: 'TokenOS is preparing your instance. SSH credentials appear within ~60s.', color: '#06b6d4' },
  COMPLETED: { title: 'Completed', desc: 'This compute allocation has ended.', color: '#71717a' },
  CANCELLED: { title: 'Cancelled', desc: 'This request was cancelled.', color: '#71717a' },
  REJECTED: { title: 'Rejected', desc: 'This request was not approved.', color: '#ef4444' },
  // WAITLISTED is the only buyer-visible state that genuinely means
  // "admin must look at this" — eligibility flagged the request
  // (first-time-over-ceiling, daily-spend, concurrent-limit, etc.).
  WAITLISTED: { title: 'Held for review', desc: 'Eligibility flagged this request. The team will get to it shortly; you can cancel and resubmit smaller if you do not want to wait.', color: '#f59e0b' },
}

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

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
      className="ml-2 p-1.5 rounded-md transition-colors hover:bg-white/10"
      title="Copy to clipboard"
    >
      {copied ? <Check size={14} style={{ color: 'var(--primary)' }} /> : <Copy size={14} style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

function TimeRemaining({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState('')

  useEffect(() => {
    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now()
      if (diff <= 0) {
        setRemaining('Expired')
        return
      }
      const days = Math.floor(diff / 86400000)
      const hours = Math.floor((diff % 86400000) / 3600000)
      const mins = Math.floor((diff % 3600000) / 60000)
      setRemaining(`${days}d ${hours}h ${mins}m`)
    }
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [expiresAt])

  return (
    <span className="text-lg font-bold" style={{ color: 'var(--primary)' }}>{remaining}</span>
  )
}

/**
 * Live cost meter, displays the buyer's burn rate updating every second.
 * Computed client-side from activatedAt + ratePerDay + gpuCount + totalCost
 * (no extra server load; no extra API calls). Caps at totalCost so the
 * meter never displays more than what was paid up-front.
 */
function LiveCostMeter({
  activatedAt,
  ratePerDay,
  gpuCount,
  totalCost,
}: {
  activatedAt: string
  ratePerDay: number
  gpuCount: number
  totalCost: number
}) {
  const [accruedUsd, setAccruedUsd] = useState(0)

  useEffect(() => {
    const ratePerSecond = (ratePerDay * gpuCount) / 86400
    const startMs = new Date(activatedAt).getTime()
    const update = () => {
      const elapsedSec = Math.max(0, (Date.now() - startMs) / 1000)
      const accrued = Math.min(elapsedSec * ratePerSecond, totalCost)
      setAccruedUsd(accrued)
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [activatedAt, ratePerDay, gpuCount, totalCost])

  const pct = totalCost > 0 ? Math.min(100, (accruedUsd / totalCost) * 100) : 0
  const ratePerHour = (ratePerDay * gpuCount) / 24

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: 'var(--primary)' }}>
            ${accruedUsd.toFixed(4)}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            accrued of ${totalCost.toFixed(2)} ({pct.toFixed(1)}%)
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
            ${ratePerHour.toFixed(4)}/hr
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>burn rate</div>
        </div>
      </div>
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.06)' }}
      >
        <div
          className="h-full transition-all duration-1000 ease-linear"
          style={{ width: `${pct}%`, background: 'var(--primary)' }}
        />
      </div>
    </div>
  )
}

export default function RequestDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const id = params.id as string

  const [data, setData] = useState<ComputeRequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [terminating, setTerminating] = useState(false)
  // M3-T5: preemption notice for THIS rental. Lives outside `data`
  // because it's pushed via WS and may arrive before the next data
  // refresh. Cleared automatically when status flips to COMPLETED.
  const [preemption, setPreemption] = useState<PreemptionPayload | null>(null)
  // T5c: Lambda-provisioned SSH credentials, fetched on-demand and
  // shown in a dedicated section. Null when the rental is internal
  // or still provisioning (the page polls every 5s for it while
  // PROVISIONING_EXTERNAL).
  const [externalCreds, setExternalCreds] = useState<{
    provider: string
    sshHost: string
    sshPort: number
    sshUsername: string
    sshPrivateKey: string
    instanceType: string
    region: string
    attestationUrl?: string | null
    attestationFetchedAt?: string | null
  } | null>(null)
  const [externalCredsError, setExternalCredsError] = useState<string | null>(null)
  const [showPrivateKey, setShowPrivateKey] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const response = (await buyer.request(id)) as { request: ComputeRequestDetail }
      setData(response.request)
    } catch {
      /* silently fail */
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadData()
    const isTerminal = data?.status === 'COMPLETED' || data?.status === 'CANCELLED' || data?.status === 'REJECTED'
    if (isTerminal) return
    const interval = setInterval(loadData, 10_000)
    return () => clearInterval(interval)
  }, [loadData, data?.status])

  // T5c: poll the external-credentials endpoint while the rental is
  // PROVISIONING_EXTERNAL or ACTIVE (and we haven't fetched creds
  // yet). 404 = internal rental, give up. 409 = still provisioning,
  // try again next tick. 200 = decrypt happened, render the section.
  useEffect(() => {
    if (!data || externalCreds) return
    if (data.status !== 'PROVISIONING_EXTERNAL' && data.status !== 'ACTIVE') return

    let cancelled = false

    const fetchCreds = async () => {
      try {
        const creds = await buyer.externalCredentials(id)
        if (!cancelled) {
          setExternalCreds(creds)
          setExternalCredsError(null)
        }
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to fetch external credentials'
        if (msg.includes('404')) {
          // Internal rental — never poll again.
          setExternalCreds(null)
          setExternalCredsError(null)
          cancelled = true
        } else if (msg.includes('409')) {
          // Still provisioning; quiet retry on the next tick.
          setExternalCredsError(null)
        } else {
          setExternalCredsError(msg)
        }
      }
    }

    fetchCreds()
    const interval = setInterval(fetchCreds, 5_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [id, data, externalCreds])

  // Real-time updates via WebSocket. compute:preemption-notice surfaces
  // the SPOT eviction grace window so the countdown banner can render
  // without waiting for the next 10s poll. compute:terminated clears
  // the banner and refreshes data (status is now COMPLETED).
  const wsEvents = useMemo(() => ({
    'compute:activated': () => loadData(),
    'compute:statusChange': () => loadData(),
    'compute:preemption-notice': (payload: unknown) => {
      const p = payload as PreemptionPayload
      if (p?.requestId !== id) return
      setPreemption(p)
    },
    'compute:terminated': (payload: unknown) => {
      const p = payload as { requestId: string }
      if (p?.requestId !== id) return
      setPreemption(null)
      loadData()
    },
  }), [id, loadData])
  useWebSocket({ events: wsEvents })

  // M3-T5 fallback: if the buyer reloaded the page mid-grace-window,
  // the WS event already fired but we never received it. Parse the
  // adminNote marker the worker writes (PREEMPT_AT:<iso>|reason=...)
  // and synthesize a banner state. Only acts on ACTIVE rentals whose
  // preemption hasn't already elapsed.
  const fallbackPreemption: PreemptionPayload | null = useMemo(() => {
    if (preemption) return null
    if (!data || data.status !== 'ACTIVE') return null
    const note = data.adminNote ?? ''
    if (!note.startsWith('PREEMPT_AT:')) return null
    const isoEnd = note.slice('PREEMPT_AT:'.length).split('|')[0]
    const preemptAt = isoEnd ? new Date(isoEnd) : null
    if (!preemptAt || Number.isNaN(preemptAt.getTime()) || preemptAt <= new Date()) return null
    return {
      requestId: data.id,
      preemptAt: preemptAt.toISOString(),
      graceMs: preemptAt.getTime() - Date.now(),
      reason: note.split('|reason=')[1] ?? 'unknown',
    }
  }, [preemption, data])
  const activePreemption = preemption ?? fallbackPreemption

  const handleCancel = async () => {
    setCancelling(true)
    try {
      await buyer.cancelRequest(id)
      toast('success', 'Request cancelled')
      loadData()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to cancel request')
    } finally {
      setCancelling(false)
    }
  }

  // Terminate ACTIVE rentals with prorated refund. Builds a confirm
  // dialog with the live numbers so the buyer sees what they're giving
  // up before clicking. The browser confirm is a second guard on top
  // of the prominent button styling.
  const handleTerminate = async () => {
    if (!data) return
    const ratePerMin = (data.ratePerDay * data.gpuCount) / (24 * 60)
    const elapsedMs = data.activatedAt ? Date.now() - new Date(data.activatedAt).getTime() : 0
    const elapsedMin = Math.max(0, Math.floor(elapsedMs / 60000))
    const accruedNow = Math.min(elapsedMin * ratePerMin, data.totalCost)
    const refundEst = Math.max(0, data.totalCost - accruedNow)
    const ok = window.confirm(
      `Terminate this rental now?\n\n` +
      `Accrued so far: $${accruedNow.toFixed(2)}\n` +
      `Refund estimate: $${refundEst.toFixed(2)}\n\n` +
      `Refund will be sent to the wallet on your account settings.`,
    )
    if (!ok) return
    setTerminating(true)
    try {
      await buyer.terminateRequest(id)
      toast('success', 'Rental terminated')
      loadData()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to terminate rental')
    } finally {
      setTerminating(false)
    }
  }

  if (loading) {
    return (
      <DashboardShell title="Loading..." subtitle="Fetching rental details">
        <div className="lg:col-span-3">
          <SectionCard>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</p>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  if (!data) {
    return (
      <DashboardShell title="Request not found" subtitle="No such rental on your account">
        <div className="lg:col-span-3">
          <SectionCard>
            <div className="text-center py-12">
              <Server size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Request not found</p>
              <button
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                onClick={() => router.push('/buyer/requests')}
              >
                Back to Requests
              </button>
            </div>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  // PENDING is a multi-state status: eligibility is being checked, OR
  // it passed and the allocator is searching for capacity, OR the
  // buyer asked for a region we can't satisfy. Pick the most-specific
  // copy by inspecting eligibilityFlags. WAITLISTED is the only state
  // that actually means "admin must look at this".
  const statusInfo = (() => {
    const flags = data.eligibilityFlags ?? []
    if (data.status === 'PENDING') {
      if (flags.includes('NO_REGION_CAPACITY')) {
        return {
          title: 'No capacity in your region right now',
          desc: 'We keep checking every 10 seconds. You can also cancel and resubmit without a region pin to widen the search.',
          color: '#f59e0b',
        }
      }
      if (flags.includes('SEARCHING_CAPACITY') || flags.includes('WAITING_ON_CAPACITY')) {
        return {
          title: 'Looking for available capacity',
          desc: 'Checking suppliers every 10 seconds for a matching GPU. Provisioning starts the moment one is available. No action needed.',
          color: '#f59e0b',
        }
      }
      // Brand new PENDING (first tick hasn't run yet) — request is
      // validated and about to be picked up. ~10s window.
      return {
        title: 'Queued',
        desc: 'Validating your request. Provisioning starts in a few seconds. No action needed.',
        color: '#f59e0b',
      }
    }
    return STATUS_MESSAGES[data.status] ?? STATUS_MESSAGES.PENDING
  })()
  const currentStepIndex = STEPS.indexOf(data.status as typeof STEPS[number])
  // PROVISIONING_EXTERNAL belongs here: the meter only starts when
  // status flips to ACTIVE, so cancelling during provisioning is a
  // full refund — same semantics as cancelling at PENDING. Was
  // missing before, which trapped buyers whose external pod failed
  // to boot. Server cancel route now accepts both states (paired
  // change in apps/api/src/routes/buyer-compute.ts).
  const canCancel = data.status === 'PENDING' || data.status === 'APPROVED' || data.status === 'PROVISIONING_EXTERNAL'

  return (
    <DashboardShell
      title={`${data.gpuTier} x${data.gpuCount}`}
      subtitle={`Rental ${data.id.slice(0, 12)}`}
    >
      <DashboardMainColumn>
        {/* Back link */}
        <button
          onClick={() => router.push('/buyer/requests')}
          className="flex items-center gap-2 text-sm transition-colors self-start"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={14} />
          Back to Requests
        </button>

        {/* M3-T5: SPOT preemption countdown — pinned above everything so
            the buyer cannot miss it during the 90s grace window. */}
        {activePreemption && (
          <SectionCard>
            <PreemptionBanner preemption={activePreemption} />
          </SectionCard>
        )}

        {/* Status Banner + tier proof badge */}
        <SectionCard>
          <div
            className="rounded-lg p-4"
            style={{
              background: `${statusInfo.color}10`,
              border: `1px solid ${statusInfo.color}30`,
            }}
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-bold" style={{ color: statusInfo.color }}>{statusInfo.title}</h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{statusInfo.desc}</p>
              </div>
              {/* M3-T7: tier proof badge. RESERVED gets a shield with
                  "exempt" copy so the buyer sees the commitment is being
                  honored at a glance. SPOT gets a lightning bolt with
                  "preemptible" copy. ON_DEMAND is the unmarked baseline. */}
              {data.tier === 'RESERVED' && (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold flex-shrink-0"
                  style={{
                    background: 'rgba(59, 130, 246, 0.12)',
                    border: '1px solid rgba(59, 130, 246, 0.4)',
                    color: '#3b82f6',
                  }}
                  title={`Reserved capacity — locked for ${data.commitmentDays ?? '?'} days, exempt from preemption regardless of demand pressure.`}
                >
                  <Shield size={12} />
                  Preemption-exempt {data.commitmentDays ? `· ${data.commitmentDays}d commitment` : ''}
                </span>
              )}
              {data.tier === 'SPOT' && (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold flex-shrink-0"
                  style={{
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.4)',
                    color: '#f59e0b',
                  }}
                  title="Spot tier — 40% off, preemptible with 90 seconds notice when On-Demand demand spikes."
                >
                  <Zap size={12} />
                  Spot · preemptible
                </span>
              )}
            </div>
          </div>
        </SectionCard>

        {/* Step Tracker / Timeline */}
        {currentStepIndex >= 0 && (
          <SectionCard title="Timeline" icon={Clock}>
            <div className="flex items-center justify-between">
              {STEPS.map((step, i) => {
                const isCompleted = i < currentStepIndex
                const isCurrent = i === currentStepIndex
                const isPending = i > currentStepIndex

                return (
                  <div key={step} className="flex items-center" style={{ flex: i < STEPS.length - 1 ? 1 : 'none' }}>
                    <div className="flex flex-col items-center">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                        style={{
                          background: isCompleted
                            ? 'var(--primary)'
                            : isCurrent
                              ? `${statusInfo.color}30`
                              : 'var(--bg-tertiary)',
                          color: isCompleted
                            ? '#fff'
                            : isCurrent
                              ? statusInfo.color
                              : 'var(--text-muted)',
                          border: isCurrent ? `2px solid ${statusInfo.color}` : 'none',
                        }}
                      >
                        {isCompleted ? <Check size={14} /> : i + 1}
                      </div>
                      <span
                        className="text-xs mt-1 whitespace-nowrap"
                        style={{ color: isPending ? 'var(--text-muted)' : 'var(--text-secondary)' }}
                      >
                        {STEP_LABELS[step]}
                      </span>
                    </div>
                    {i < STEPS.length - 1 && (
                      <div
                        className="flex-1 h-0.5 mx-2"
                        style={{
                          background: isCompleted ? 'var(--primary)' : 'var(--border-color)',
                          marginTop: '-16px',
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </SectionCard>
        )}

        {/* External-provisioned credentials not yet available. The
            polling effect above retries every 5s. Underlying supplier
            stays abstracted — buyers see "TokenOS Compute," not a
            named third-party cloud. */}
        {data.status === 'PROVISIONING_EXTERNAL' && !externalCreds && (
          <SectionCard
            title="Provisioning your compute"
            icon={Cloud}
            badge={
              <span
                className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(6, 182, 212, 0.12)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.35)' }}
              >
                TokenOS
              </span>
            }
          >
            <div className="flex items-center gap-3 py-4">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--info)' }} />
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Your instance is booting. SSH credentials will appear here within ~60 seconds.
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  This page refreshes automatically.
                </div>
              </div>
            </div>
            {externalCredsError && (
              <div className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                {externalCredsError}
              </div>
            )}
          </SectionCard>
        )}

        {/* SSH access for externally-provisioned rentals. Same
            key-based auth flow as internal nodes — but with the
            supplier name abstracted away to keep TokenOS unified. */}
        {externalCreds && (data.status === 'ACTIVE' || data.status === 'PROVISIONING_EXTERNAL') && (
          <SectionCard
            title="SSH Access"
            icon={Cloud}
            badge={
              <span
                className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(6, 182, 212, 0.12)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.35)' }}
              >
                {externalCreds.region}
              </span>
            }
          >
            <div className="space-y-3">
              <div className="text-xs font-mono uppercase tracking-wider pb-2" style={{ color: 'var(--text-muted)' }}>
                {externalCreds.instanceType}
              </div>
              <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Host</span>
                <div className="flex items-center">
                  <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{externalCreds.sshHost}</span>
                  <CopyButton text={externalCreds.sshHost} />
                </div>
              </div>
              <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Port</span>
                <div className="flex items-center">
                  <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{externalCreds.sshPort}</span>
                  <CopyButton text={String(externalCreds.sshPort)} />
                </div>
              </div>
              <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Username</span>
                <div className="flex items-center">
                  <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{externalCreds.sshUsername}</span>
                  <CopyButton text={externalCreds.sshUsername} />
                </div>
              </div>

              {/* Private key block — collapsed by default, click to show,
                  download as .pem when ready. */}
              <div className="py-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    Private key (OpenSSH PEM)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowPrivateKey((v) => !v)}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5 transition-colors"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {showPrivateKey ? <EyeOff size={12} /> : <Eye size={12} />}
                      {showPrivateKey ? 'Hide' : 'Show'}
                    </button>
                    <button
                      onClick={() => {
                        const blob = new Blob([externalCreds.sshPrivateKey], { type: 'application/x-pem-file' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url
                        a.download = `tokenos-rental-${id.slice(0, 12)}.pem`
                        document.body.appendChild(a)
                        a.click()
                        document.body.removeChild(a)
                        URL.revokeObjectURL(url)
                      }}
                      className="text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5 transition-colors"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <Download size={12} />
                      Download .pem
                    </button>
                    <CopyButton text={externalCreds.sshPrivateKey} />
                  </div>
                </div>
                <pre
                  className="text-xs font-mono p-3 rounded-lg overflow-x-auto max-h-48 overflow-y-auto"
                  style={{
                    background: 'var(--bg-card)',
                    color: showPrivateKey ? 'var(--text-primary)' : 'var(--text-muted)',
                    filter: showPrivateKey ? undefined : 'blur(6px)',
                    userSelect: showPrivateKey ? 'text' : 'none',
                    transition: 'filter 200ms ease-out',
                  }}
                >
                  {externalCreds.sshPrivateKey}
                </pre>
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Save this file (chmod 600) — it's only shown here while the rental is live.
                </p>
              </div>
            </div>

            {/* Ready-to-run SSH command. Phala dstack-gateway hosts
                (https://...phala.network) need TLS-tunneled SSH via
                openssl ProxyCommand; other providers use direct TCP. */}
            {(() => {
              // Detect Phala dstack-gateway hosts whether the URL was
              // stored with or without the https:// prefix. Either
              // shape requires openssl ProxyCommand because the gateway
              // terminates TLS at 443 with SNI routing.
              const isDstackTproxy =
                typeof externalCreds.sshHost === 'string' &&
                externalCreds.sshHost.includes('.phala.network')
              const pemName = `tokenos-rental-${id.slice(0, 12)}.pem`
              if (isDstackTproxy) {
                const hostname = externalCreds.sshHost
                  .replace(/^https:\/\//, '')
                  .replace(/\/$/, '')
                const tunneledCmd = `ssh -i ${pemName} -o "ProxyCommand=openssl s_client -quiet -connect ${hostname}:443 -servername ${hostname} 2>/dev/null" -o StrictHostKeyChecking=no ${externalCreds.sshUsername}@${hostname}`
                return (
                  <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--bg-card)' }}>
                    <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                      Phala routes SSH over TLS via the dstack gateway. Use openssl as a ProxyCommand to bridge the connection:
                    </p>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-mono break-all" style={{ color: 'var(--text-secondary)' }}>
                        {tunneledCmd}
                      </p>
                      <CopyButton text={tunneledCmd} />
                    </div>
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                      Requires openssl installed locally. Direct{' '}
                      <code className="font-mono">ssh user@host</code> will fail because the gateway terminates TLS at port 443 with SNI routing, not raw TCP at port 22.
                    </p>
                  </div>
                )
              }
              const directCmd = `ssh -i ${pemName} ${externalCreds.sshUsername}@${externalCreds.sshHost} -p ${externalCreds.sshPort}`
              return (
                <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--bg-card)' }}>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {directCmd}
                    </p>
                    <CopyButton text={directCmd} />
                  </div>
                </div>
              )
            })()}

            {/* T7: Cryptographic attestation. Only renders for
                confidential rentals (VoltageGPU / Phala / io.net allow-
                listed) where the provider exposes an attestation URL. */}
            {externalCreds.attestationUrl && (
              <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid rgba(99, 102, 241, 0.3)' }}>
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                      Cryptographic attestation
                    </div>
                    <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                      Hardware-signed proof your workload is running inside the TEE. Verify with the provider tools or your own attestation client.
                    </p>
                    <a
                      href={externalCreds.attestationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono inline-flex items-center gap-1 hover:underline"
                      style={{ color: 'rgb(99, 102, 241)' }}
                    >
                      View attestation report &rarr;
                    </a>
                    {externalCreds.attestationFetchedAt && (
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        Captured {new Date(externalCreds.attestationFetchedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </SectionCard>
        )}

        {/* SSH Access (only when ACTIVE) */}
        {data.status === 'ACTIVE' && data.sshHost && !externalCreds && (
          <SectionCard title="SSH Access" icon={Terminal}>
            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Host</span>
                <div className="flex items-center">
                  <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{data.sshHost}</span>
                  <CopyButton text={data.sshHost} />
                </div>
              </div>
              <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Port</span>
                <div className="flex items-center">
                  <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{data.sshPort}</span>
                  <CopyButton text={String(data.sshPort)} />
                </div>
              </div>
              <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Username</span>
                <div className="flex items-center">
                  <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{data.sshUsername}</span>
                  <CopyButton text={data.sshUsername ?? ''} />
                </div>
              </div>
              {data.sshPassword && (
                <div className="flex items-center justify-between py-2 text-sm">
                  <span style={{ color: 'var(--text-muted)' }}>Password</span>
                  <div className="flex items-center">
                    <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{'*'.repeat(16)}</span>
                    <CopyButton text={data.sshPassword} />
                  </div>
                </div>
              )}
            </div>
            <div className="mt-4 p-3 rounded-lg flex items-center justify-between" style={{ background: 'var(--bg-card)' }}>
              <p className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                ssh {data.sshUsername}@{data.sshHost} -p {data.sshPort}
              </p>
              <CopyButton text={`ssh ${data.sshUsername}@${data.sshHost} -p ${data.sshPort}`} />
            </div>
          </SectionCard>
        )}

        {/* Terminate Rental, full-width destructive CTA */}
        {data.status === 'ACTIVE' && (
          <SectionCard>
            <button
              type="button"
              onClick={handleTerminate}
              disabled={terminating}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold transition-all"
              style={{
                background: terminating ? 'rgba(239, 68, 68, 0.05)' : 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: '#ef4444',
                opacity: terminating ? 0.6 : 1,
                cursor: terminating ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!terminating) e.currentTarget.style.background = 'rgba(239, 68, 68, 0.18)'
              }}
              onMouseLeave={(e) => {
                if (!terminating) e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'
              }}
            >
              <XCircle size={16} />
              {terminating ? 'Terminating...' : 'Terminate Rental'}
            </button>
            <p className="text-xs text-center mt-2" style={{ color: 'var(--text-muted)' }}>
              End your rental now and refund any unused time to the wallet on your account settings.
            </p>
          </SectionCard>
        )}

        {/* Cancel Button (only for PENDING/APPROVED, not yet allocated) */}
        {canCancel && (
          <div className="flex justify-end">
            <Button
              variant="danger"
              size="sm"
              onClick={handleCancel}
              loading={cancelling}
            >
              <XCircle size={14} className="mr-1" />
              Cancel Request
            </Button>
          </div>
        )}
      </DashboardMainColumn>

      <DashboardRightRail>
        {/* Cost Breakdown */}
        <SectionCard title="Cost Breakdown" icon={FileText}>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>GPU Tier</span>
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{data.gpuTier}</span>
            </div>
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>GPU Count</span>
              <span style={{ color: 'var(--text-primary)' }}>{data.gpuCount}</span>
            </div>
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Duration</span>
              <span style={{ color: 'var(--text-primary)' }}>{data.durationDays} days</span>
            </div>
            {data.purpose && (
              <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Purpose</span>
                <span style={{ color: 'var(--text-primary)' }}>{data.purpose}</span>
              </div>
            )}
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Total Cost</span>
              <span className="font-bold" style={{ color: 'var(--primary)' }}>{formatCurrency(data.totalCost)}</span>
            </div>
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>TX Hash</span>
              <div className="flex items-center">
                <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {data.txHash.length > 20 ? `${data.txHash.slice(0, 6)}...${data.txHash.slice(-6)}` : data.txHash}
                </span>
                <CopyButton text={data.txHash} />
              </div>
            </div>
            <div className="flex justify-between py-2">
              <span style={{ color: 'var(--text-muted)' }}>Submitted</span>
              <span style={{ color: 'var(--text-secondary)' }} className="text-xs">
                {new Date(data.requestedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          </div>

          {/* Invoice Download — auth-fetched, opens HTML in a new tab
              so the user can View / Print / Save as PDF natively.
              Can't be a plain <a href> because the route is Bearer-
              authed and browsers don't attach the token on new-tab
              opens. */}
          {['ACTIVE', 'COMPLETED', 'APPROVED', 'ALLOCATED'].includes(data.status) && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await buyer.downloadInvoice(id)
                } catch (e) {
                  toast('error', e instanceof Error ? e.message : 'Failed to fetch invoice')
                }
              }}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all hover:opacity-90"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--primary)' }}
            >
              <Download size={14} />
              Download Invoice
            </button>
          )}
        </SectionCard>

        {/* Time Remaining (only when ACTIVE) */}
        {data.status === 'ACTIVE' && data.expiresAt && (
          <SectionCard title="Time Remaining" icon={Clock}>
            <TimeRemaining expiresAt={data.expiresAt} />
          </SectionCard>
        )}

        {/* Live Cost Meter (only when ACTIVE) */}
        {data.status === 'ACTIVE' && data.activatedAt && data.ratePerDay && (
          <SectionCard title="Live Cost" icon={DollarSign}>
            <LiveCostMeter
              activatedAt={data.activatedAt}
              ratePerDay={data.ratePerDay}
              gpuCount={data.gpuCount}
              totalCost={data.totalCost}
            />
          </SectionCard>
        )}

        {/* Rate this rental (only when COMPLETED) */}
        {data.status === 'COMPLETED' && (
          <SectionCard title="Rate this rental" icon={Star}>
            <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
              Help other buyers pick reliable operators. Your rating is moderated before publishing.
            </p>
            <button
              type="button"
              onClick={() => router.push(`/buyer/rate/${id}`)}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors"
              style={{ background: 'var(--primary)', color: '#fff' }}
            >
              <Star size={14} />
              Rate Operator
            </button>
          </SectionCard>
        )}
      </DashboardRightRail>
    </DashboardShell>
  )
}
