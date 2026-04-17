'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Server,
  CheckCircle,
  Clock,
  XCircle,
  Loader2,
  RefreshCw,
  Lock,
  Key,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVar = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
}

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
}

type StatusFilter = 'all' | 'PENDING' | 'APPROVED' | 'ALLOCATED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'REJECTED'

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Allocated', value: 'ALLOCATED' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Cancelled', value: 'CANCELLED' },
  { label: 'Rejected', value: 'REJECTED' },
]

export default function ComputeRequestsPage() {
  const [requests, setRequests] = useState<ComputeRequest[]>([])
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, allocated: 0, active: 0, completed: 0, cancelled: 0, rejected: 0 })
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

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const status = filter !== 'all' ? filter : undefined
      const [requestsData, availData] = await Promise.all([
        api.compute.list(status),
        api.compute.availability(),
      ])
      setRequests(requestsData.requests || [])
      setCounts(requestsData.counts || { pending: 0, approved: 0, allocated: 0, active: 0, completed: 0, cancelled: 0, rejected: 0 })
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
      default: return 0
    }
  }

  if (loading && requests.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    )
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-accent text-white px-4 py-3 rounded-lg shadow-lg animate-scaleIn">
          {toast}
        </div>
      )}

      {/* Header */}
      <motion.div variants={itemVar} className="dash-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          <Server size={28} style={{ color: 'var(--primary)' }} />
          Compute Requests
          {counts.pending > 0 && (
            <span className="px-2.5 py-1 text-sm font-semibold bg-warning/10 text-warning rounded-lg">
              {counts.pending} pending
            </span>
          )}
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => loadData()}
            className="px-3 py-2 text-sm bg-surface border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex items-center gap-2"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </motion.div>

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

      {/* KPI Stat Blocks */}
      <motion.div variants={itemVar} className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'PENDING' ? 'border-warning' : 'border-border hover:border-warning/50'
          }`}
          onClick={() => setFilter(filter === 'PENDING' ? 'all' : 'PENDING')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-warning/10 rounded-lg flex items-center justify-center">
              <Clock size={20} className="text-warning" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Pending Requests</p>
              <p className="text-2xl font-bold text-warning">{counts.pending}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'ACTIVE' ? 'border-accent' : 'border-border hover:border-accent/50'
          }`}
          onClick={() => setFilter(filter === 'ACTIVE' ? 'all' : 'ACTIVE')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
              <CheckCircle size={20} className="text-accent" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Active Allocations</p>
              <p className="text-2xl font-bold text-accent">{counts.active}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'APPROVED' ? 'border-blue-400' : 'border-border hover:border-blue-400/50'
          }`}
          onClick={() => setFilter(filter === 'APPROVED' ? 'all' : 'APPROVED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-500/10 rounded-lg flex items-center justify-center">
              <Server size={20} className="text-blue-400" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Approved</p>
              <p className="text-2xl font-bold text-blue-400">{counts.approved}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'COMPLETED' ? 'border-text-muted' : 'border-border hover:border-text-muted/50'
          }`}
          onClick={() => setFilter(filter === 'COMPLETED' ? 'all' : 'COMPLETED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-text-muted/10 rounded-lg flex items-center justify-center">
              <XCircle size={20} className="text-text-muted" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Completed</p>
              <p className="text-2xl font-bold text-text-muted">{counts.completed}</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Node Availability */}
      <motion.div variants={itemVar}>
        <div className="rounded-xl p-5" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <h2 className="text-lg font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Server size={18} className="text-accent" />
            Node Availability
          </h2>
          {availability.length === 0 ? (
            <p className="text-text-muted text-sm">No availability data</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {availability.map((tier) => (
                <div key={tier.tier} className="bg-surface border border-border rounded-lg p-3">
                  <p className="text-sm font-medium text-accent">{tier.tier}</p>
                  <p className="text-lg font-bold text-text-primary">
                    {tier.idle} <span className="text-text-muted text-sm font-normal">/ {tier.total}</span>
                  </p>
                  <p className="text-xs text-text-muted">idle nodes</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>

      {/* Status Filter Pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_FILTERS.map((sf) => (
          <button
            key={sf.value}
            onClick={() => setFilter(sf.value)}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              filter === sf.value
                ? 'bg-accent text-white'
                : 'bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            {sf.label}
            <span className={`ml-1.5 ${filter === sf.value ? 'text-white/70' : 'text-text-muted'}`}>
              {getFilterCount(sf.value)}
            </span>
          </button>
        ))}
      </div>

      {/* Requests Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {filter === 'all' ? 'All Requests' : `${STATUS_FILTERS.find(f => f.value === filter)?.label} Requests`}
          </h2>
          {filter !== 'all' && (
            <button
              onClick={() => setFilter('all')}
              className="text-sm text-accent hover:underline"
            >
              Show all
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-hover">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Buyer</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">GPU Tier</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Count</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Duration</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Cost</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Date</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-text-muted">
                    No compute requests found
                  </td>
                </tr>
              ) : (
                requests.map((req) => (
                  <tr key={req.id} className="hover:bg-surface-hover transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-text-primary text-sm">{req.user?.email ?? "N/A"}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm font-medium">
                        {req.gpuTier}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-text-primary font-medium">
                      {req.gpuCount}
                    </td>
                    <td className="px-6 py-4 text-text-secondary text-sm">
                      {req.durationDays}d
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-text-primary font-medium">
                        ${req.totalCost.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(req.status)}
                    </td>
                    <td className="px-6 py-4 text-text-muted text-sm">
                      {new Date(req.requestedAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {req.status === 'PENDING' && (
                          <>
                            <button
                              onClick={() => handleApprove(req.id)}
                              disabled={actionLoading === req.id}
                              className="px-3 py-1.5 text-sm bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded-lg transition-colors disabled:opacity-50"
                            >
                              {actionLoading === req.id ? <Loader2 size={14} className="animate-spin" /> : 'Approve'}
                            </button>
                            <button
                              onClick={() => handleAutoAllocate(req.id)}
                              disabled={actionLoading === req.id}
                              className="px-3 py-1.5 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors disabled:opacity-50"
                            >
                              Auto Allocate
                            </button>
                            <button
                              onClick={() => openRejectModal(req)}
                              className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {req.status === 'APPROVED' && (
                          <>
                            <button
                              onClick={() => handleAutoAllocate(req.id)}
                              disabled={actionLoading === req.id}
                              className="px-3 py-1.5 text-sm bg-accent/10 text-accent hover:bg-accent/20 rounded-lg transition-colors disabled:opacity-50"
                            >
                              {actionLoading === req.id ? <Loader2 size={14} className="animate-spin" /> : 'Auto Allocate'}
                            </button>
                            <button
                              onClick={() => openAllocateModal(req)}
                              className="px-3 py-1.5 text-sm bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 rounded-lg transition-colors"
                            >
                              Manual Allocate
                            </button>
                            <button
                              onClick={() => openActivateModal(req)}
                              className="px-3 py-1.5 text-sm bg-warning/10 text-warning hover:bg-warning/20 rounded-lg transition-colors"
                            >
                              Activate
                            </button>
                          </>
                        )}
                        {req.status === 'ALLOCATED' && (
                          <button
                            onClick={() => handleActivateDirect(req.id)}
                            disabled={actionLoading === req.id}
                            className="px-3 py-1.5 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-50"
                          >
                            {actionLoading === req.id ? <Loader2 size={14} className="animate-spin" /> : 'Activate'}
                          </button>
                        )}
                        {req.status === 'ACTIVE' && (
                          <button
                            onClick={() => handleComplete(req.id)}
                            disabled={actionLoading === req.id}
                            className="px-3 py-1.5 text-sm bg-text-muted/10 text-text-secondary hover:bg-text-muted/20 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {actionLoading === req.id ? <Loader2 size={14} className="animate-spin" /> : 'Complete'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
            {' '}&mdash;{' '}
            <span className="text-accent font-medium">{selectedRequest?.gpuTier}</span>
            {' '}x{selectedRequest?.gpuCount}
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
            {' '}&mdash;{' '}
            <span className="text-accent font-medium">{selectedRequest?.gpuTier}</span>
            {' '}x{selectedRequest?.gpuCount}
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
    </motion.div>
  )
}
