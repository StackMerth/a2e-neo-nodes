'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'

interface Job {
  id: string
  deploymentId: string
  gpuTier: string
  status: string
  market: string | null
  ratePerHour: number | null
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

const GPU_TIERS = ['H100', 'H200', 'B200', 'B300', 'GB300']

export default function JobsPage() {
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
      alert('Deployment ID is required')
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
      loadJobs()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create job')
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
      loadJobs()
    } catch (err) {
      alert(err instanceof Error ? err.message : `Failed to ${action} job`)
    } finally {
      setActionInProgress(null)
    }
  }

  async function handleBulkCancel() {
    setBulkProcessing(true)
    try {
      const result = await api.jobs.bulkCancel(selectedJobs)
      alert(`Cancelled: ${result.cancelled}\nFailed: ${result.failed}`)
      setSelectedJobs([])
      setShowBulkCancelModal(false)
      loadJobs()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Bulk cancel failed')
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

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Jobs</h1>
          <p className="text-text-muted mt-1">
            View and manage routing decisions and job status
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={loadJobs} variant="secondary" size="sm">
            Refresh
          </Button>
          <Button onClick={() => setShowCreateModal(true)} variant="primary" size="sm">
            Create Job
          </Button>
        </div>
      </div>

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
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by deployment ID or job ID..."
            className="w-full px-4 py-2 bg-background border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
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
        <div className="flex items-center gap-4 p-3 bg-accent/10 border border-accent/30 rounded-lg">
          <span className="text-sm text-accent font-medium">
            {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setShowBulkCancelModal(true)}
              className="px-3 py-1.5 text-xs bg-error/10 text-error rounded-lg hover:bg-error/20 transition-colors"
            >
              Cancel Selected
            </button>
            <button
              onClick={clearSelection}
              className="px-3 py-1.5 text-xs bg-surface-hover text-text-secondary rounded-lg hover:bg-border transition-colors"
            >
              Clear Selection
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      <Card>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-text-muted">Loading...</p>
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-text-muted">
              {search ? 'No jobs match your search' : 'No jobs yet. '}
              {!search && <a href="/routing" className="text-accent hover:underline">Test routing</a>}
              {!search && ' to create one.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">
                    <input
                      type="checkbox"
                      checked={selectedJobs.length > 0 && selectedJobs.length === filteredJobs.filter(j => !['COMPLETED', 'FAILED'].includes(j.status)).length}
                      onChange={(e) => e.target.checked ? selectAllJobs() : clearSelection()}
                      className="w-4 h-4 rounded border-border accent-accent"
                    />
                  </th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Deployment</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">GPU</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Market</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Status</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Rate</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Requested</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => (
                  <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover">
                    <td className="py-3 px-4">
                      {!['COMPLETED', 'FAILED'].includes(job.status) && (
                        <input
                          type="checkbox"
                          checked={selectedJobs.includes(job.id)}
                          onChange={() => toggleJobSelection(job.id)}
                          className="w-4 h-4 rounded border-border accent-accent"
                        />
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <Link href={`/jobs/${job.id}`} className="text-sm text-accent hover:underline font-medium">
                        {job.deploymentId}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-1 bg-accent/10 text-accent text-xs rounded">
                        {job.gpuTier}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getMarketColor(job.market)}`}>
                        {job.market || 'PENDING'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${getStatusColor(job.status).split(' ')[0]}`} />
                        <span className="text-sm text-text-secondary">{job.status}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-primary">
                      {job.ratePerHour ? `$${(job.ratePerHour * 24).toFixed(2)}/day` : '-'}
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-muted">
                      {new Date(job.requestedAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="px-2 py-1 text-xs bg-surface-hover text-text-secondary rounded hover:bg-border transition-colors"
                        >
                          View
                        </Link>
                        {canPerformAction(job, 'cancel') && (
                          <button
                            onClick={() => handleJobAction(job.id, 'cancel')}
                            disabled={actionInProgress === job.id}
                            className="px-2 py-1 text-xs bg-error/10 text-error rounded hover:bg-error/20 disabled:opacity-50 transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                        {canPerformAction(job, 'retry') && (
                          <button
                            onClick={() => handleJobAction(job.id, 'retry')}
                            disabled={actionInProgress === job.id}
                            className="px-2 py-1 text-xs bg-warning/10 text-warning rounded hover:bg-warning/20 disabled:opacity-50 transition-colors"
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
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-sm bg-surface-hover hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                Previous
              </button>
              <span className="px-3 py-1.5 text-sm text-text-muted">
                Page {page} of {pagination.totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page === pagination.totalPages}
                className="px-3 py-1.5 text-sm bg-surface-hover hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                Next
              </button>
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
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              Deployment ID
            </label>
            <input
              type="text"
              value={createForm.deploymentId}
              onChange={(e) => setCreateForm({ ...createForm, deploymentId: e.target.value })}
              placeholder="e.g., #104"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">
              GPU Tier
            </label>
            <select
              value={createForm.gpuTier}
              onChange={(e) => setCreateForm({ ...createForm, gpuTier: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent"
            >
              {GPU_TIERS.map((tier) => (
                <option key={tier} value={tier}>{tier}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="autoRoute"
              checked={createForm.autoRoute}
              onChange={(e) => setCreateForm({ ...createForm, autoRoute: e.target.checked })}
              className="w-4 h-4 rounded border-border accent-accent"
            />
            <label htmlFor="autoRoute" className="text-sm text-text-secondary">
              Auto-route to best market
            </label>
          </div>
          <div className="flex gap-3 pt-4">
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
              variant="primary"
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
    </div>
  )
}
