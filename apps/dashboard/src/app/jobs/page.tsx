'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Briefcase, Play, Clock, CircleCheck, RefreshCw, Plus, Search,
  AlertTriangle, CircleX, Loader2, Ban, Zap,
} from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface Job {
  id: string
  deploymentId: string
  gpuTier: string
  status: string
  market: string | null
  ratePerHour: number | null
  earnings: number | null
  cost: number | null
  profit: number | null
  requestedAt: string
}

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ROUTING', label: 'Routing' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
]

const MARKET_OPTIONS = [
  { value: '', label: 'All Markets' },
  { value: 'INTERNAL', label: 'Internal' },
  { value: 'AKASH', label: 'Akash' },
  { value: 'IONET', label: 'IO.net' },
]

// C2 wave 2: include consumer / prosumer tiers so admins can filter
// jobs that ran on edge inventory (inference-only workloads).
const GPU_TIERS = ['H100', 'H200', 'B200', 'B300', 'GB300', 'RTX_4090', 'RTX_3090', 'CONSUMER']

export default function JobsPage() {
  const { addToast } = useToast()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [marketFilter, setMarketFilter] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [selectedJobs, setSelectedJobs] = useState<string[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showBulkCancelModal, setShowBulkCancelModal] = useState(false)
  const [bulkProcessing, setBulkProcessing] = useState(false)
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  // Create job form state
  const [createForm, setCreateForm] = useState({
    deploymentId: '',
    gpuTier: 'H100',
    autoRoute: true,
  })
  const [creating, setCreating] = useState(false)

  const loadJobs = useCallback(async () => {
    try {
      const params: { limit: number; page: number; status?: string; market?: string } = { limit: 20, page }
      if (statusFilter) params.status = statusFilter
      if (marketFilter) params.market = marketFilter
      const data = await api.jobs.list(params)
      setJobs(data.jobs)
      setPagination(data.pagination)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, marketFilter, page])

  useEffect(() => {
    loadJobs()
    const interval = setInterval(loadJobs, 10000)
    return () => clearInterval(interval)
  }, [loadJobs])

  // Filter jobs by search term
  const filteredJobs = useMemo(() => {
    if (!search.trim()) return jobs
    const term = search.toLowerCase()
    return jobs.filter(
      j =>
        j.deploymentId.toLowerCase().includes(term) ||
        j.id.toLowerCase().includes(term) ||
        j.gpuTier.toLowerCase().includes(term)
    )
  }, [jobs, search])

  // Calculate job stats
  const jobStats = useMemo(() => {
    const byStatus: Record<string, number> = {}
    const byMarket: Record<string, number> = {}
    jobs.forEach(j => {
      byStatus[j.status] = (byStatus[j.status] || 0) + 1
      if (j.market) byMarket[j.market] = (byMarket[j.market] || 0) + 1
    })
    return { byStatus, byMarket }
  }, [jobs])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'bg-accent text-accent'
      case 'RUNNING': return 'bg-blue-500 text-blue-400'
      case 'ASSIGNED': return 'bg-purple-500 text-purple-400'
      case 'PENDING': return 'bg-warning text-warning'
      case 'FAILED': return 'bg-error text-error'
      default: return 'bg-text-muted text-text-muted'
    }
  }

  const getMarketColor = (market: string | null) => {
    switch (market) {
      case 'INTERNAL': return 'bg-accent/10 text-accent'
      case 'AKASH': return 'bg-blue-500/10 text-blue-400'
      case 'IONET': return 'bg-purple-500/10 text-purple-400'
      default: return 'bg-surface text-text-muted'
    }
  }

  function toggleJobSelection(jobId: string) {
    setSelectedJobs(prev =>
      prev.includes(jobId)
        ? prev.filter(id => id !== jobId)
        : [...prev, jobId]
    )
  }

  function selectAllJobs() {
    const selectableJobs = filteredJobs.filter(j => !['COMPLETED', 'FAILED'].includes(j.status))
    setSelectedJobs(selectableJobs.map(j => j.id))
  }

  function clearSelection() {
    setSelectedJobs([])
  }

  async function handleCreateJob() {
    if (!createForm.deploymentId.trim()) {
      addToast({ type: 'warning', title: 'Validation Error', message: 'Deployment ID is required' })
      return
    }
    setCreating(true)
    try {
      await api.jobs.create({
        deploymentId: createForm.deploymentId.trim(),
        gpuTier: createForm.gpuTier,
        autoRoute: createForm.autoRoute,
      })
      setShowCreateModal(false)
      setCreateForm({ deploymentId: '', gpuTier: 'H100', autoRoute: true })
      addToast({ type: 'success', title: 'Job Created', message: 'New job created successfully' })
      loadJobs()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to create job' })
    } finally {
      setCreating(false)
    }
  }

  async function handleJobAction(jobId: string, action: 'cancel' | 'retry' | 'requeue') {
    setActionInProgress(jobId)
    try {
      switch (action) {
        case 'cancel':
          await api.jobs.cancel(jobId)
          break
        case 'retry':
          await api.jobs.retry(jobId)
          break
        case 'requeue':
          await api.jobs.requeue(jobId)
          break
      }
      addToast({ type: 'success', title: 'Action Completed', message: `Job ${action} successful` })
      loadJobs()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : `Failed to ${action} job` })
    } finally {
      setActionInProgress(null)
    }
  }

  async function handleBulkCancel() {
    setBulkProcessing(true)
    try {
      const result = await api.jobs.bulkCancel(selectedJobs)
      addToast({ type: 'success', title: 'Bulk Cancel Complete', message: `Cancelled: ${result.cancelled}, Failed: ${result.failed}` })
      setSelectedJobs([])
      setShowBulkCancelModal(false)
      loadJobs()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Bulk cancel failed' })
    } finally {
      setBulkProcessing(false)
    }
  }

  const canPerformAction = (job: Job, action: 'cancel' | 'retry' | 'requeue') => {
    switch (action) {
      case 'cancel':
        return ['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING'].includes(job.status)
      case 'retry':
        return job.status === 'FAILED'
      case 'requeue':
        return job.status === 'FAILED'
      default:
        return false
    }
  }

  // Market distribution for chart
  const marketDistribution = [
    { label: 'Internal', value: jobStats.byMarket.INTERNAL || 0, color: 'accent' as const },
    { label: 'Akash', value: jobStats.byMarket.AKASH || 0, color: 'blue' as const },
    { label: 'IO.net', value: jobStats.byMarket.IONET || 0, color: 'purple' as const },
  ]

  return (
    <motion.div className="space-y-8" variants={container} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          <Briefcase size={28} style={{ color: 'var(--primary)' }} />
          Jobs
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button onClick={loadJobs} variant="secondary" size="sm" icon={<RefreshCw size={16} />}>
            Refresh
          </Button>
          <Button onClick={() => setShowCreateModal(true)} variant="gradient" size="sm" icon={<Plus size={16} />}>
            Create Job
          </Button>
        </div>
      </motion.div>

      {/* Stats Grid */}
      <motion.div variants={item} className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Jobs"
          value={pagination?.total ?? jobs.length}
          variant="default"
          icon={<Briefcase size={20} />}
        />
        <StatCard
          label="Running"
          value={jobStats.byStatus.RUNNING || 0}
          variant="blue"
          icon={<Play size={20} />}
        />
        <StatCard
          label="Pending"
          value={(jobStats.byStatus.PENDING || 0) + (jobStats.byStatus.ROUTING || 0)}
          variant="orange"
          icon={<Clock size={20} />}
        />
        <StatCard
          label="Completed"
          value={jobStats.byStatus.COMPLETED || 0}
          variant="accent"
          icon={<CircleCheck size={20} />}
        />
      </motion.div>

      {/* Market Distribution */}
      {(pagination?.total ?? jobs.length) > 0 && (
        <Card variant="glass" title="Market Distribution" description="Jobs routed by market">
          <div className="mt-4">
            <DistributionBar segments={marketDistribution} size="lg" showLegend />
          </div>
        </Card>
      )}

      {/* Filters and Search */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="w-40">
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value)
              setPage(1)
            }}
            options={STATUS_OPTIONS}
          />
        </div>
        <div className="w-40">
          <Select
            value={marketFilter}
            onChange={(e) => {
              setMarketFilter(e.target.value)
              setPage(1)
            }}
            options={MARKET_OPTIONS}
          />
        </div>
        <div className="flex-1 max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by deployment ID or job ID..."
              className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 transition-all"
            />
          </div>
        </div>
        {(statusFilter || marketFilter || search) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusFilter('')
              setMarketFilter('')
              setSearch('')
            }}
          >
            Clear Filters
          </Button>
        )}
        <span className="text-sm text-text-muted ml-auto">
          {pagination ? `${pagination.total} total` : `${jobs.length} jobs`}
        </span>
      </div>

      {/* Bulk Actions Bar */}
      {selectedJobs.length > 0 && (
        <div className="flex items-center gap-4 p-4 bg-accent/5 border border-accent/20 rounded-xl animate-slideUp">
          <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
            <CircleCheck size={20} className="text-accent" />
          </div>
          <span className="text-sm text-accent font-medium">
            {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-2 ml-auto">
            <Button
              onClick={() => setShowBulkCancelModal(true)}
              variant="outline"
              size="sm"
              className="border-error/30 text-error hover:bg-error/10"
            >
              Cancel Selected
            </Button>
            <Button
              onClick={clearSelection}
              variant="ghost"
              size="sm"
            >
              Clear Selection
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-error/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} className="text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {/* Jobs Table */}
      <Card variant="glass">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mb-4">
              <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
            <p className="text-text-muted">Loading jobs...</p>
          </div>
        ) : filteredJobs.length === 0 ? (
          <EmptyState
            icon={<Briefcase size={32} />}
            title={search ? 'No jobs match your search' : 'No jobs yet'}
            description={search ? 'Try adjusting your search or filters' : 'Create your first job or test routing to get started'}
            action={
              !search && (
                <div className="flex gap-3">
                  <Link href="/routing">
                    <Button variant="outline" size="sm">Test Routing</Button>
                  </Link>
                  <Button variant="gradient" size="sm" onClick={() => setShowCreateModal(true)}>
                    Create Job
                  </Button>
                </div>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">
                    <input
                      type="checkbox"
                      checked={selectedJobs.length > 0 && selectedJobs.length === filteredJobs.filter(j => !['COMPLETED', 'FAILED'].includes(j.status)).length}
                      onChange={(e) => e.target.checked ? selectAllJobs() : clearSelection()}
                      className="w-4 h-4 rounded border-border accent-accent"
                    />
                  </th>
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">Deployment</th>
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">GPU</th>
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">Market</th>
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">Status</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Rate</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Earnings</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Profit</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Requested</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => (
                  <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                    <td className="py-4 px-4">
                      {!['COMPLETED', 'FAILED'].includes(job.status) && (
                        <input
                          type="checkbox"
                          checked={selectedJobs.includes(job.id)}
                          onChange={() => toggleJobSelection(job.id)}
                          className="w-4 h-4 rounded border-border accent-accent"
                        />
                      )}
                    </td>
                    <td className="py-4 px-4">
                      <Link href={`/jobs/${job.id}`} className="text-sm text-accent hover:underline font-medium">
                        {job.deploymentId}
                      </Link>
                    </td>
                    <td className="py-4 px-4">
                      <span className="px-2.5 py-1 bg-accent/10 text-accent text-xs rounded-lg font-medium">
                        {job.gpuTier}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${getMarketColor(job.market)}`}>
                        {job.market || 'PENDING'}
                      </span>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${getStatusColor(job.status).split(' ')[0]}`} />
                        <span className="text-sm text-text-secondary">{job.status}</span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-right text-sm text-text-primary font-medium">
                      {job.ratePerHour ? `$${(job.ratePerHour * 24).toFixed(2)}/day` : '-'}
                    </td>
                    <td className="py-4 px-4 text-right text-sm text-text-primary">
                      {job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-'}
                    </td>
                    <td className="py-4 px-4 text-right text-sm">
                      {job.profit != null ? (
                        <span className={job.profit >= 0 ? 'text-accent' : 'text-error'}>
                          {job.profit >= 0 ? '+' : ''}${job.profit.toFixed(4)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="py-4 px-4 text-right text-sm text-text-muted">
                      {new Date(job.requestedAt).toLocaleString()}
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="px-3 py-1.5 text-xs bg-surface-hover text-text-secondary rounded-lg hover:bg-border transition-colors font-medium"
                        >
                          View
                        </Link>
                        {canPerformAction(job, 'cancel') && (
                          <button
                            onClick={() => handleJobAction(job.id, 'cancel')}
                            disabled={actionInProgress === job.id}
                            className="px-3 py-1.5 text-xs bg-error/10 text-error rounded-lg hover:bg-error/20 disabled:opacity-50 transition-colors font-medium"
                          >
                            Cancel
                          </button>
                        )}
                        {canPerformAction(job, 'retry') && (
                          <button
                            onClick={() => handleJobAction(job.id, 'retry')}
                            disabled={actionInProgress === job.id}
                            className="px-3 py-1.5 text-xs bg-warning/10 text-warning rounded-lg hover:bg-warning/20 disabled:opacity-50 transition-colors font-medium"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-4 border-t border-border">
            <p className="text-sm text-text-muted">
              Showing {((page - 1) * pagination.limit) + 1} to {Math.min(page * pagination.limit, pagination.total)} of {pagination.total} jobs
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                variant="secondary"
                size="sm"
              >
                Previous
              </Button>
              <span className="px-4 py-2 text-sm text-text-muted bg-surface rounded-lg">
                Page {page} of {pagination.totalPages}
              </span>
              <Button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page === pagination.totalPages}
                variant="secondary"
                size="sm"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Create Job Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create New Job"
        size="md"
      >
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              Deployment ID
            </label>
            <input
              type="text"
              value={createForm.deploymentId}
              onChange={(e) => setCreateForm({ ...createForm, deploymentId: e.target.value })}
              placeholder="e.g., #104"
              className="w-full px-4 py-3 bg-background border border-border rounded-xl text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 transition-all"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              GPU Tier
            </label>
            <select
              value={createForm.gpuTier}
              onChange={(e) => setCreateForm({ ...createForm, gpuTier: e.target.value })}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 transition-all"
            >
              {GPU_TIERS.map((tier) => (
                <option key={tier} value={tier}>{tier}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 p-4 bg-surface rounded-xl">
            <input
              type="checkbox"
              id="autoRoute"
              checked={createForm.autoRoute}
              onChange={(e) => setCreateForm({ ...createForm, autoRoute: e.target.checked })}
              className="w-5 h-5 rounded border-border accent-accent"
            />
            <label htmlFor="autoRoute" className="text-sm text-text-secondary">
              Auto-route to best market
            </label>
          </div>
          <div className="flex gap-3 pt-2">
            <Button
              onClick={() => setShowCreateModal(false)}
              variant="outline"
              className="flex-1"
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateJob}
              variant="gradient"
              className="flex-1"
              disabled={creating}
            >
              {creating ? 'Creating...' : 'Create Job'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Bulk Cancel Modal */}
      <ConfirmModal
        isOpen={showBulkCancelModal}
        onClose={() => setShowBulkCancelModal(false)}
        onConfirm={handleBulkCancel}
        title="Cancel Selected Jobs"
        message={`Are you sure you want to cancel ${selectedJobs.length} job${selectedJobs.length !== 1 ? 's' : ''}? This action cannot be undone.`}
        confirmText={bulkProcessing ? 'Cancelling...' : `Cancel ${selectedJobs.length} Jobs`}
        variant="danger"
        loading={bulkProcessing}
      />
    </motion.div>
  )
}

// Empty State Component
function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="py-16 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4 text-text-muted">
        {icon}
      </div>
      <h3 className="text-lg font-medium text-text-primary mb-2">{title}</h3>
      <p className="text-sm text-text-muted mb-6 max-w-sm mx-auto">{description}</p>
      {action}
    </div>
  )
}

// SVG icon functions removed - using lucide-react imports
function _legacyBriefcaseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function PlayIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ClockIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function CheckIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function RefreshIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}

function PlusIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}

function SearchIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )
}

function AlertIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}
