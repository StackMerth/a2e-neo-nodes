'use client'

import { useState, useEffect, useCallback } from 'react'
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
  sshHost?: string
  sshPort?: number
  sshUsername?: string
  sshPassword?: string
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
  PENDING: { title: 'Waiting for Approval', desc: 'Your request is being reviewed by the admin team.', color: '#f59e0b' },
  APPROVED: { title: 'Request Approved', desc: 'Your request has been approved and resources are being prepared.', color: '#3b82f6' },
  ALLOCATED: { title: 'Resources Allocated', desc: 'GPUs have been allocated and are being configured for you.', color: '#8b5cf6' },
  ACTIVE: { title: 'Active, Connect via SSH', desc: 'Your compute resources are ready. Use the SSH details below to connect.', color: '#22c55e' },
  COMPLETED: { title: 'Completed', desc: 'This compute allocation has ended.', color: '#71717a' },
  CANCELLED: { title: 'Cancelled', desc: 'This request was cancelled.', color: '#71717a' },
  REJECTED: { title: 'Rejected', desc: 'This request was not approved.', color: '#ef4444' },
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

  // Real-time updates via WebSocket
  const handleComputeEvent = useCallback(() => { loadData() }, [loadData])
  useWebSocket({
    events: { 'compute:activated': handleComputeEvent, 'compute:statusChange': handleComputeEvent },
  })

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

  const statusInfo = STATUS_MESSAGES[data.status] ?? STATUS_MESSAGES.PENDING
  const currentStepIndex = STEPS.indexOf(data.status as typeof STEPS[number])
  const canCancel = data.status === 'PENDING' || data.status === 'APPROVED'

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

        {/* Status Banner */}
        <SectionCard>
          <div
            className="rounded-lg p-4"
            style={{
              background: `${statusInfo.color}10`,
              border: `1px solid ${statusInfo.color}30`,
            }}
          >
            <h2 className="text-lg font-bold" style={{ color: statusInfo.color }}>{statusInfo.title}</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{statusInfo.desc}</p>
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

        {/* SSH Access (only when ACTIVE) */}
        {data.status === 'ACTIVE' && data.sshHost && (
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

          {/* Invoice Download */}
          {['ACTIVE', 'COMPLETED', 'APPROVED', 'ALLOCATED'].includes(data.status) && (
            <a
              href={buyer.invoiceUrl(id)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--primary)' }}
            >
              <Download size={14} />
              Download Invoice
            </a>
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
