'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Server,
  CheckCircle,
  Clock,
  XCircle,
  Loader2,
  Lock,
  Key,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import {
  DashboardShell,
  MetricTriad,
  SectionCard,
  DataTableCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

interface ComputeRequest {
  id: string
  user?: { id: string; email: string | null; walletAddress: string | null }
  gpuTier: string
  gpuCount: number
  durationDays: number
  totalCost: number
  status: string
  sshHost: string | null
  sshPort: number | null
  sshUsername: string | null
  sshPassword: string | null
  allocatedNodeIds?: string[]
  adminNote: string | null
  requestedAt: string
  // M2: eligibility flags written by the auto-allocator. Present on
  // WAITLISTED rows so the admin can see why a request was held.
  eligibilityFlags?: string[]
}

type ComputeRow = ComputeRequest & Record<string, unknown>

interface TierAvailability {
  tier: string
  idle: number
  total: number
  busy: number
}

interface Counts {
  pending: number
  approved: number
  allocated: number
  active: number
  completed: number
  cancelled: number
  rejected: number
  waitlisted: number
  terminated: number
}

// 'TERMINATED' isn't a real DB status — it's a derived view of COMPLETED
// rows where adminNote indicates a buyer-initiated early terminate (vs
// auto-expiry). Filtering happens client-side after fetching COMPLETED.
type StatusFilter = 'all' | 'PENDING' | 'APPROVED' | 'ALLOCATED' | 'ACTIVE' | 'COMPLETED' | 'TERMINATED' | 'CANCELLED' | 'REJECTED' | 'WAITLISTED'

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Needs Review', value: 'WAITLISTED' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Allocated', value: 'ALLOCATED' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Terminated', value: 'TERMINATED' },
  { label: 'Cancelled', value: 'CANCELLED' },
  { label: 'Rejected', value: 'REJECTED' },
]

// Predicate: a row counts as "terminated early" if its adminNote starts
// with 'Buyer terminated'. Auto-expired rows have 'Auto-completed: ...'
// so they fall outside this filter (still appear in 'Completed').
const isTerminatedRow = (req: { status: string; adminNote: string | null }) =>
  req.status === 'COMPLETED' &&
  typeof req.adminNote === 'string' &&
  req.adminNote.startsWith('Buyer terminated')

// Friendly explanations for every eligibility flag the auto-allocator
// can write. Keys are the raw flag values from the API; values are
// admin-facing explanations shown in the Details modal so admins don't
// have to memorize what each flag means.
const FLAG_DESCRIPTIONS: Record<string, { kind: 'hold' | 'pass' | 'info'; title: string; desc: string }> = {
  HOLD_FIRST_TIME_OVER_CEILING: {
    kind: 'hold',
    title: 'First-time buyer over spend ceiling',
    desc: 'This buyer has zero successful rentals AND the request totalCost exceeds $500 (default ALLOCATOR_FIRST_TIME_CEILING_USD). Held to give the team a chance to review unfamiliar buyers spending real money on their first rental.',
  },
  HOLD_DAILY_SPEND_EXCEEDED: {
    kind: 'hold',
    title: 'Daily spend cap exceeded',
    desc: 'This buyer\'s last 24h of requests + this new request would exceed their per-day spend cap (default $10,000, tunable per buyer via User.maxDailySpendUsd).',
  },
  HOLD_CONCURRENT_LIMIT: {
    kind: 'hold',
    title: 'Concurrent rental limit',
    desc: 'This buyer is already at their maxConcurrentRentals cap (default 10). One of their existing rentals must end before this one allocates.',
  },
  HOLD_UNVERIFIED_EMAIL: {
    kind: 'hold',
    title: 'Email not verified',
    desc: 'This buyer hasn\'t clicked the verification email yet. Trust signal — verified email is a basic eligibility check.',
  },
  PASS_FAST_TRACK: {
    kind: 'pass',
    title: 'Fast-tracked',
    desc: 'Buyer has 3+ successful rentals (ALLOCATOR_TRUSTED_RENTAL_COUNT). Skipped the first-time ceiling check.',
  },
  PASS_NORMAL: {
    kind: 'pass',
    title: 'Normal eligibility pass',
    desc: 'All eligibility rules passed without holds.',
  },
  PASS_MANUAL_REVIEW: {
    kind: 'pass',
    title: 'Manually reviewed by admin',
    desc: 'Admin clicked Release Hold on this request. The eligibility engine bypassed re-evaluation so the request can proceed.',
  },
  MANUAL_REVIEW_PASSED: {
    kind: 'info',
    title: 'Manual review marker',
    desc: 'Internal flag carried on the row so subsequent allocator ticks recognize the bypass. Persists across capacity-wait re-evaluations.',
  },
  WAITING_ON_CAPACITY: {
    kind: 'info',
    title: 'Waiting on capacity',
    desc: 'Allocator ran but found no idle nodes matching the requested GPU tier. The request stays PENDING and retries on the next 10s tick. Will allocate as soon as a matching node frees up.',
  },
}

export default function ComputeRequestsPage() {
  const [requests, setRequests] = useState<ComputeRequest[]>([])
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, allocated: 0, active: 0, completed: 0, cancelled: 0, rejected: 0, waitlisted: 0, terminated: 0 })
  const [availability, setAvailability] = useState<TierAvailability[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [toast, setToast] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Modal states
  const [allocateModalOpen, setAllocateModalOpen] = useState(false)
  const [activateModalOpen, setActivateModalOpen] = useState(false)
  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [selectedRequest, setSelectedRequest] = useState<ComputeRequest | null>(null)

  // Allocate form
  const [allocateData, setAllocateData] = useState({
    nodeIds: '',
    sshHost: '',
    sshPort: 22,
    sshUsername: 'root',
    sshPassword: '',
  })

  // Activate SSH form
  const [activateData, setActivateData] = useState({
    sshHost: '',
    sshPort: 22,
    sshUsername: 'root',
    sshPassword: '',
  })

  // Reject form
  const [rejectReason, setRejectReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Details modal: opened from yellow flag chip OR info icon next to status.
  // Single surface for "tell me everything about this row" (admin note plus every
  // eligibility flag with a friendly description).
  const [detailsRequest, setDetailsRequest] = useState<ComputeRequest | null>(null)

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      // 'TERMINATED' is a derived client-side view of COMPLETED rows.
      // Ask the API for COMPLETED and filter on the client. 'all' fetches
      // everything. Otherwise pass the status straight through.
      const apiStatus = filter === 'all'
        ? undefined
        : filter === 'TERMINATED'
          ? 'COMPLETED'
          : filter
      const [requestsData, availData] = await Promise.all([
        api.compute.list(apiStatus),
        api.compute.availability(),
      ])
      const allRows = requestsData.requests || []
      // Apply the TERMINATED predicate client-side so we don't show
      // auto-expired rentals here; those stay under 'Completed'.
      setRequests(filter === 'TERMINATED' ? allRows.filter(isTerminatedRow) : allRows)
      setCounts(requestsData.counts || { pending: 0, approved: 0, allocated: 0, active: 0, completed: 0, cancelled: 0, rejected: 0, waitlisted: 0, terminated: 0 })
      // Convert availability object to array
      const availObj = (availData as { availability: Record<string, { total: number; idle: number; busy: number }> }).availability || {}
      setAvailability(Object.entries(availObj).map(([tier, data]) => ({ tier, ...data })))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compute requests')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadData()
    }, 10000)
    return () => clearInterval(interval)
  }, [loadData])

  // Auto-hide toast after 4 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  async function handleApprove(id: string) {
    try {
      setActionLoading(id)
      await api.compute.approve(id)
      setToast('Request approved')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve request')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleReleaseHold(id: string) {
    try {
      setActionLoading(id)
      await api.compute.releaseHold(id)
      setToast('Hold released, auto-allocator will pick this up within 10s')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release hold')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleAutoAllocate(id: string) {
    try {
      setActionLoading(id)
      const result = await api.compute.autoAllocate(id)
      setToast(`${result.nodesAllocated} node${result.nodesAllocated !== 1 ? 's' : ''} auto-allocated`)
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Insufficient supply for auto-allocation')
    } finally {
      setActionLoading(null)
    }
  }

  function openAllocateModal(req: ComputeRequest) {
    setSelectedRequest(req)
    setAllocateData({ nodeIds: '', sshHost: '', sshPort: 22, sshUsername: 'root', sshPassword: '' })
    setAllocateModalOpen(true)
  }

  async function handleAllocateSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedRequest) return
    try {
      setSubmitting(true)
      await api.compute.allocate(selectedRequest.id, {
        nodeIds: allocateData.nodeIds.split(',').map(s => s.trim()).filter(Boolean),
        sshHost: allocateData.sshHost,
        sshPort: allocateData.sshPort,
        sshUsername: allocateData.sshUsername,
        sshPassword: allocateData.sshPassword,
      })
      setAllocateModalOpen(false)
      setToast('Nodes manually allocated')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to allocate nodes')
    } finally {
      setSubmitting(false)
    }
  }

  function openActivateModal(req: ComputeRequest) {
    setSelectedRequest(req)
    setActivateData({ sshHost: '', sshPort: 22, sshUsername: 'root', sshPassword: '' })
    setActivateModalOpen(true)
  }

  async function handleActivateSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedRequest) return
    try {
      setSubmitting(true)
      await api.compute.activate(selectedRequest.id, {
        sshHost: activateData.sshHost,
        sshPort: activateData.sshPort,
        sshUsername: activateData.sshUsername,
        sshPassword: activateData.sshPassword,
      })
      setActivateModalOpen(false)
      setToast('Request activated')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate request')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleActivateDirect(id: string) {
    try {
      setActionLoading(id)
      await api.compute.activate(id)
      setToast('Request activated')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate request')
    } finally {
      setActionLoading(null)
    }
  }

  function openRejectModal(req: ComputeRequest) {
    setSelectedRequest(req)
    setRejectReason('')
    setRejectModalOpen(true)
  }

  async function handleRejectSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedRequest) return
    try {
      setSubmitting(true)
      await api.compute.reject(selectedRequest.id, rejectReason || undefined)
      setRejectModalOpen(false)
      setToast('Request rejected')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject request')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleComplete(id: string) {
    try {
      setActionLoading(id)
      await api.compute.complete(id)
      setToast('Request marked as completed')
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete request')
    } finally {
      setActionLoading(null)
    }
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'PENDING':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning">
            Pending
          </span>
        )
      case 'APPROVED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400">
            Approved
          </span>
        )
      case 'ALLOCATED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent-purple/10 text-accent-purple">
            Allocated
          </span>
        )
      case 'ACTIVE':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            Active
          </span>
        )
      case 'COMPLETED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted">
            Completed
          </span>
        )
      case 'CANCELLED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted">
            Cancelled
          </span>
        )
      case 'REJECTED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-error/10 text-error">
            Rejected
          </span>
        )
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted">
            {status}
          </span>
        )
    }
  }

  function getFilterCount(value: StatusFilter): number {
    if (value === 'all') return requests.length
    switch (value) {
      case 'PENDING': return counts.pending
      case 'APPROVED': return counts.approved
      case 'ALLOCATED': return counts.allocated
      case 'ACTIVE': return counts.active
      case 'COMPLETED': return counts.completed
      case 'CANCELLED': return counts.cancelled
      case 'REJECTED': return counts.rejected
      case 'WAITLISTED': return counts.waitlisted
      case 'TERMINATED': return counts.terminated
      default: return 0
    }
  }

  const metrics: MetricCardData[] = [
    { label: 'Pending Requests', value: counts.pending, icon: Clock, tone: 'orange' },
    { label: 'Active Allocations', value: counts.active, icon: CheckCircle, tone: 'green' },
    { label: 'Approved', value: counts.approved, icon: Server, tone: 'blue' },
  ]

  const columns: Array<DataTableColumn<ComputeRow>> = [
    {
      key: 'user',
      header: 'Buyer',
      render: (r) => (
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {r.user?.email ?? 'N/A'}
        </span>
      ),
    },
    {
      key: 'gpuTier',
      header: 'GPU',
      render: (r) => (
        <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm font-medium">
          {r.gpuTier}
        </span>
      ),
    },
    {
      key: 'gpuCount',
      header: 'Count',
      mono: true,
      render: (r) => r.gpuCount,
    },
    {
      key: 'durationDays',
      header: 'Duration',
      mono: true,
      render: (r) => `${r.durationDays}d`,
    },
    {
      key: 'totalCost',
      header: 'Cost',
      align: 'right',
      mono: true,
      render: (r) => `$${r.totalCost.toLocaleString()}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="flex items-center gap-2">
          {getStatusBadge(r.status)}
          {r.adminNote && (
            <button
              type="button"
              onClick={() => setDetailsRequest(r)}
              title={`Note: ${r.adminNote.slice(0, 80)}${r.adminNote.length > 80 ? '…' : ''}`}
              className="w-5 h-5 rounded-full bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 flex items-center justify-center text-xs font-bold transition-colors cursor-pointer"
            >
              i
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'requestedAt',
      header: 'Date',
      mono: true,
      render: (r) => new Date(r.requestedAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-2 flex-wrap">
          {r.status === 'PENDING' && (
            <>
              {r.eligibilityFlags && r.eligibilityFlags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDetailsRequest(r)}
                  className="px-2 py-1 text-xs rounded bg-accent/10 text-accent font-mono whitespace-nowrap hover:bg-accent/20 transition-colors cursor-pointer"
                  title="Click for details"
                >
                  {r.eligibilityFlags.includes('WAITING_ON_CAPACITY')
                    ? 'waiting on capacity'
                    : r.eligibilityFlags.includes('MANUAL_REVIEW_PASSED')
                      ? 'reviewed'
                      : `${r.eligibilityFlags.length} flag(s)`}
                </button>
              )}
              <button
                onClick={() => handleApprove(r.id)}
                disabled={actionLoading === r.id}
                className="px-3 py-1.5 text-sm bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors disabled:opacity-50"
              >
                {actionLoading === r.id ? <Loader2 size={14} className="animate-spin" /> : 'Approve'}
              </button>
              <button
                onClick={() => handleAutoAllocate(r.id)}
                disabled={actionLoading === r.id}
                className="px-3 py-1.5 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors disabled:opacity-50"
              >
                Auto Allocate
              </button>
              <button
                onClick={() => openRejectModal(r)}
                className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors"
              >
                Reject
              </button>
            </>
          )}
          {r.status === 'WAITLISTED' && (
            <>
              {r.eligibilityFlags && r.eligibilityFlags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDetailsRequest(r)}
                  className="px-2 py-1 text-xs rounded bg-warning/10 text-warning font-mono whitespace-nowrap hover:bg-warning/20 transition-colors cursor-pointer"
                  title="Click to see why this request is held"
                >
                  {r.eligibilityFlags.filter(f => f.startsWith('HOLD_')).length} flag(s) ⓘ
                </button>
              )}
              <button
                onClick={() => handleReleaseHold(r.id)}
                disabled={actionLoading === r.id}
                className="px-3 py-1.5 text-sm bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors disabled:opacity-50"
              >
                {actionLoading === r.id ? <Loader2 size={14} className="animate-spin" /> : 'Release Hold'}
              </button>
              <button
                onClick={() => openRejectModal(r)}
                className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors"
              >
                Reject
              </button>
            </>
          )}
          {r.status === 'APPROVED' && (
            <>
              <button
                onClick={() => handleAutoAllocate(r.id)}
                disabled={actionLoading === r.id}
                className="px-3 py-1.5 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors disabled:opacity-50"
              >
                {actionLoading === r.id ? <Loader2 size={14} className="animate-spin" /> : 'Auto Allocate'}
              </button>
              <button
                onClick={() => openAllocateModal(r)}
                className="px-3 py-1.5 text-sm bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 rounded-lg transition-colors"
              >
                Manual Allocate
              </button>
              <button
                onClick={() => openActivateModal(r)}
                className="px-3 py-1.5 text-sm bg-warning/10 text-warning hover:bg-warning/20 rounded-lg transition-colors"
              >
                Activate
              </button>
            </>
          )}
          {r.status === 'ALLOCATED' && (
            <button
              onClick={() => handleActivateDirect(r.id)}
              disabled={actionLoading === r.id}
              className="px-3 py-1.5 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-50"
            >
              {actionLoading === r.id ? <Loader2 size={14} className="animate-spin" /> : 'Activate'}
            </button>
          )}
          {r.status === 'ACTIVE' && (
            <button
              onClick={() => handleComplete(r.id)}
              disabled={actionLoading === r.id}
              className="px-3 py-1.5 text-sm bg-text-muted/10 text-text-secondary hover:bg-text-muted/20 rounded-lg transition-colors disabled:opacity-50"
            >
              {actionLoading === r.id ? <Loader2 size={14} className="animate-spin" /> : 'Complete'}
            </button>
          )}
        </div>
      ),
    },
  ]

  const statusPills = (
    <div className="flex items-center gap-2 flex-wrap">
      {STATUS_FILTERS.map((sf) => {
        const isActive = filter === sf.value
        return (
          <button
            key={sf.value}
            onClick={() => setFilter(sf.value)}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {sf.label}
            <span className="ml-1.5" style={{ color: isActive ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
              {getFilterCount(sf.value)}
            </span>
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="Compute Requests"
      subtitle={counts.pending > 0 ? `${counts.pending} pending review` : `${requests.length} requests`}
      onRefresh={loadData}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 bg-accent text-white px-4 py-3 rounded-lg shadow-lg animate-scaleIn">
            {toast}
          </div>
        )}

        {error && (
          <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-3 text-error/70 hover:text-error underline text-sm"
            >
              Dismiss
            </button>
          </div>
        )}

        <MetricTriad metrics={metrics} />

        <SectionCard title="Node Availability" icon={Server}>
          {availability.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No availability data</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {availability.map((tier) => (
                <div
                  key={tier.tier}
                  className="rounded-md p-3 border"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-color)' }}
                >
                  <p className="text-sm font-medium" style={{ color: 'var(--primary)' }}>{tier.tier}</p>
                  <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {tier.idle} <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>/ {tier.total}</span>
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>idle nodes</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <DataTableCard<ComputeRow>
          title={filter === 'all' ? 'All Requests' : `${STATUS_FILTERS.find(f => f.value === filter)?.label} Requests`}
          icon={Server}
          actions={statusPills}
          columns={columns}
          rows={requests as ComputeRow[]}
          loading={loading && requests.length === 0}
          empty={
            <p className="text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No compute requests found
            </p>
          }
        />
      </div>

      {/* Manual Allocate Modal */}
      <Modal
        isOpen={allocateModalOpen}
        onClose={() => setAllocateModalOpen(false)}
        title="Manual Allocate Nodes"
        size="lg"
      >
        <form onSubmit={handleAllocateSubmit} className="space-y-4">
          <p className="text-text-muted">
            Manually allocate nodes for{' '}
            <span className="text-text-primary font-medium">{selectedRequest?.user?.email ?? "N/A"}</span>
            {' '}({' '}
            <span className="text-accent font-medium">{selectedRequest?.gpuTier}</span>
            {' '}x{selectedRequest?.gpuCount})
          </p>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Node IDs (comma-separated) *
            </label>
            <input
              type="text"
              value={allocateData.nodeIds}
              onChange={(e) => setAllocateData({ ...allocateData, nodeIds: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="node-id-1, node-id-2"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                <Lock size={14} className="inline mr-1" />
                SSH Host *
              </label>
              <input
                type="text"
                value={allocateData.sshHost}
                onChange={(e) => setAllocateData({ ...allocateData, sshHost: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="192.168.1.100"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Port
              </label>
              <input
                type="number"
                value={allocateData.sshPort}
                onChange={(e) => setAllocateData({ ...allocateData, sshPort: parseInt(e.target.value) || 22 })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="22"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Username *
            </label>
            <input
              type="text"
              value={allocateData.sshUsername}
              onChange={(e) => setAllocateData({ ...allocateData, sshUsername: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="root"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <Key size={14} className="inline mr-1" />
              Password *
            </label>
            <input
              type="password"
              value={allocateData.sshPassword}
              onChange={(e) => setAllocateData({ ...allocateData, sshPassword: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="SSH password"
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setAllocateModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Allocating...
                </>
              ) : (
                'Allocate Nodes'
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Activate with SSH Modal */}
      <Modal
        isOpen={activateModalOpen}
        onClose={() => setActivateModalOpen(false)}
        title="Activate with SSH Credentials"
        size="lg"
      >
        <form onSubmit={handleActivateSubmit} className="space-y-4">
          <p className="text-text-muted">
            Provide SSH access to activate{' '}
            <span className="text-text-primary font-medium">{selectedRequest?.user?.email ?? "N/A"}</span>
            {' '}({' '}
            <span className="text-accent font-medium">{selectedRequest?.gpuTier}</span>
            {' '}x{selectedRequest?.gpuCount})
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                <Lock size={14} className="inline mr-1" />
                SSH Host *
              </label>
              <input
                type="text"
                value={activateData.sshHost}
                onChange={(e) => setActivateData({ ...activateData, sshHost: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="192.168.1.100"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Port
              </label>
              <input
                type="number"
                value={activateData.sshPort}
                onChange={(e) => setActivateData({ ...activateData, sshPort: parseInt(e.target.value) || 22 })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="22"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Username *
            </label>
            <input
              type="text"
              value={activateData.sshUsername}
              onChange={(e) => setActivateData({ ...activateData, sshUsername: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="root"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <Key size={14} className="inline mr-1" />
              Password *
            </label>
            <input
              type="password"
              value={activateData.sshPassword}
              onChange={(e) => setActivateData({ ...activateData, sshPassword: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="SSH password"
              required
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setActivateModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Activating...
                </>
              ) : (
                'Activate'
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Reject Modal */}
      <Modal
        isOpen={rejectModalOpen}
        onClose={() => setRejectModalOpen(false)}
        title="Reject Request"
        size="md"
      >
        <form onSubmit={handleRejectSubmit} className="space-y-4">
          <p className="text-text-muted">
            Reject compute request from{' '}
            <span className="text-text-primary font-medium">{selectedRequest?.user?.email ?? "N/A"}</span>?
          </p>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Reason (optional)
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-error"
              placeholder="Reason for rejection..."
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setRejectModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-error hover:bg-error/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Rejecting...
                </>
              ) : (
                'Reject Request'
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Details modal shows adminNote and every eligibility flag with a
          friendly description. Triggered by either the yellow flag chip
          or the small 'i' info icon next to the status badge. */}
      <Modal
        isOpen={!!detailsRequest}
        onClose={() => setDetailsRequest(null)}
        title="Request Details"
        size="lg"
      >
        {detailsRequest && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 pb-4 border-b border-border">
              <div>
                <p className="text-xs text-text-muted uppercase tracking-wide">Buyer</p>
                <p className="text-text-primary">{detailsRequest.user?.email ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-text-muted uppercase tracking-wide">Status</p>
                <p>{getStatusBadge(detailsRequest.status)}</p>
              </div>
              <div>
                <p className="text-xs text-text-muted uppercase tracking-wide">GPU</p>
                <p className="text-text-primary">{detailsRequest.gpuCount}x {detailsRequest.gpuTier}</p>
              </div>
              <div>
                <p className="text-xs text-text-muted uppercase tracking-wide">Total Cost</p>
                <p className="text-text-primary">${detailsRequest.totalCost.toLocaleString()}</p>
              </div>
            </div>

            {detailsRequest.adminNote && (
              <div>
                <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Admin Note</p>
                <div className="rounded-lg p-3 bg-blue-500/5 border border-blue-500/20 text-text-primary text-xs font-mono break-all">
                  {detailsRequest.adminNote}
                </div>
              </div>
            )}

            {detailsRequest.eligibilityFlags && detailsRequest.eligibilityFlags.length > 0 && (
              <div>
                <p className="text-xs text-text-muted uppercase tracking-wide mb-2">
                  Eligibility Flags ({detailsRequest.eligibilityFlags.length})
                </p>
                <div className="space-y-2">
                  {detailsRequest.eligibilityFlags.map(flag => {
                    const meta = FLAG_DESCRIPTIONS[flag]
                    const colors = meta?.kind === 'hold'
                      ? { bg: 'bg-warning/10', border: 'border-warning/30', text: 'text-warning' }
                      : meta?.kind === 'pass'
                        ? { bg: 'bg-success/10', border: 'border-success/30', text: 'text-success' }
                        : { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400' }
                    return (
                      <div
                        key={flag}
                        className={`rounded-lg p-3 ${colors.bg} border ${colors.border}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-mono font-semibold ${colors.text}`}>{flag}</span>
                          {meta && (
                            <span className={`text-xs ${colors.text} opacity-80`}>{meta.title}</span>
                          )}
                        </div>
                        <p className="text-xs text-text-secondary">
                          {meta?.desc ?? 'No description available for this flag.'}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {!detailsRequest.adminNote && (!detailsRequest.eligibilityFlags || detailsRequest.eligibilityFlags.length === 0) && (
              <p className="text-xs text-text-muted italic text-center py-4">
                No additional notes or eligibility flags on this request.
              </p>
            )}

            <div className="pt-3 border-t border-border flex justify-end">
              <button
                type="button"
                onClick={() => setDetailsRequest(null)}
                className="px-4 py-2 text-sm bg-surface text-text-secondary hover:text-text-primary rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </DashboardShell>
  )
}
