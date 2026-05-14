'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import {
  Briefcase, Plus, Search,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

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

type JobRow = Job & Record<string, unknown>

interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

const STATUS_OPTIONS = ['', 'PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED'] as const
const MARKET_OPTIONS = ['', 'INTERNAL', 'AKASH', 'IONET'] as const

const GPU_TIERS = ['H100', 'H200', 'B200', 'B300', 'GB300']

export default function JobsPage() {
  const { addToast } = useToast()
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
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
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to load jobs' })
    } finally {
      setLoading(false)
    }
  }, [statusFilter, marketFilter, page, addToast])

  useEffect(() => {
    loadJobs()
    const interval = setInterval(loadJobs, 10000)
    return () => clearInterval(interval)
  }, [loadJobs])

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

  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'COMPLETED': return { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' }
      case 'RUNNING':   return { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' }
      case 'ASSIGNED':  return { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' }
      case 'PENDING':   return { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)' }
      case 'FAILED':    return { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }
      case 'ROUTING':   return { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)' }
      default:          return { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
    }
  }

  const getMarketBadgeStyle = (market: string | null) => {
    switch (market) {
      case 'INTERNAL': return { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' }
      case 'AKASH':    return { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' }
      case 'IONET':    return { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' }
      default:         return { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
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

  const columns: Array<DataTableColumn<JobRow>> = [
    {
      key: 'id',
      header: (
        <input
          type="checkbox"
          checked={selectedJobs.length > 0 && selectedJobs.length === filteredJobs.filter(j => !['COMPLETED', 'FAILED'].includes(j.status)).length}
          onChange={(e) => e.target.checked ? selectAllJobs() : clearSelection()}
          className="w-4 h-4 rounded border-border accent-accent"
        />
      ),
      width: '40px',
      render: (j) => !['COMPLETED', 'FAILED'].includes(j.status) && (
        <input
          type="checkbox"
          checked={selectedJobs.includes(j.id)}
          onChange={() => toggleJobSelection(j.id)}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded border-border accent-accent"
        />
      ),
    },
    {
      key: 'deploymentId',
      header: 'Deployment',
      render: (j) => (
        <Link href={`/jobs/${j.id}`} className="hover:underline" style={{ color: 'var(--primary)' }}>
          {j.deploymentId}
        </Link>
      ),
    },
    {
      key: 'gpuTier',
      header: 'GPU',
      render: (j) => (
        <span
          className="text-xs font-medium px-2 py-0.5 rounded-full"
          style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success)' }}
        >
          {j.gpuTier}
        </span>
      ),
    },
    {
      key: 'market',
      header: 'Market',
      render: (j) => {
        const ss = getMarketBadgeStyle(j.market)
        return (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: ss.bg, color: ss.color }}>
            {j.market || 'PENDING'}
          </span>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (j) => {
        const ss = getStatusBadgeStyle(j.status)
        return (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: ss.bg, color: ss.color }}>
            {j.status}
          </span>
        )
      },
    },
    {
      key: 'ratePerHour',
      header: 'Rate',
      align: 'right',
      mono: true,
      render: (j) => j.ratePerHour ? `$${(j.ratePerHour * 24).toFixed(2)}/day` : '-',
    },
    {
      key: 'earnings',
      header: 'Earnings',
      align: 'right',
      mono: true,
      render: (j) => j.earnings != null ? `$${j.earnings.toFixed(4)}` : '-',
    },
    {
      key: 'profit',
      header: 'Profit',
      align: 'right',
      mono: true,
      render: (j) => {
        if (j.profit == null) return '-'
        return (
          <span style={{ color: j.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {j.profit >= 0 ? '+' : ''}${j.profit.toFixed(4)}
          </span>
        )
      },
    },
    {
      key: 'requestedAt',
      header: 'Requested',
      align: 'right',
      mono: true,
      render: (j) => new Date(j.requestedAt).toLocaleDateString(),
    },
    {
      key: 'deploymentId',
      header: 'Actions',
      align: 'right',
      render: (j) => (
        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/jobs/${j.id}`}
            className="px-3 py-1.5 text-xs rounded-md transition-colors"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
          >
            View
          </Link>
          {canPerformAction(j, 'cancel') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleJobAction(j.id, 'cancel') }}
              disabled={actionInProgress === j.id}
              className="px-3 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50"
              style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }}
            >
              Cancel
            </button>
          )}
          {canPerformAction(j, 'retry') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleJobAction(j.id, 'retry') }}
              disabled={actionInProgress === j.id}
              className="px-3 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50"
              style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--warning)' }}
            >
              Retry
            </button>
          )}
        </div>
      ),
    },
  ]

  const filterBar = (
    <div className="flex gap-2 flex-wrap items-center">
      <div className="flex gap-1 flex-wrap">
        {STATUS_OPTIONS.map(s => {
          const isActive = statusFilter === s
          return (
            <button
              key={s || 'all'}
              onClick={() => { setStatusFilter(s); setPage(1) }}
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={isActive
                ? { background: 'var(--primary)', color: '#fff' }
                : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
              }
            >
              {s || 'All'}
            </button>
          )
        })}
      </div>
      <div className="flex gap-1 flex-wrap">
        {MARKET_OPTIONS.map(s => {
          const isActive = marketFilter === s
          return (
            <button
              key={s || 'allM'}
              onClick={() => { setMarketFilter(s); setPage(1) }}
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={isActive
                ? { background: 'var(--primary)', color: '#fff' }
                : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
              }
            >
              {s || 'All Markets'}
            </button>
          )
        })}
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="pl-9 pr-3 py-1.5 text-xs rounded-md focus:outline-none"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
        />
      </div>
      <Button onClick={() => setShowCreateModal(true)} variant="gradient" size="sm" icon={<Plus size={14} />}>
        Create
      </Button>
    </div>
  )

  return (
    <DashboardShell
      title="Jobs"
      subtitle={pagination ? `${pagination.total} total` : `${jobs.length} jobs`}
      onRefresh={loadJobs}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        {selectedJobs.length > 0 && (
          <div
            className="flex items-center gap-4 p-4 rounded-md"
            style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}
          >
            <span className="text-sm font-medium" style={{ color: 'var(--primary)' }}>
              {selectedJobs.length} job{selectedJobs.length !== 1 ? 's' : ''} selected
            </span>
            <div className="flex gap-2 ml-auto">
              <Button
                onClick={() => setShowBulkCancelModal(true)}
                variant="outline"
                size="sm"
              >
                Cancel Selected
              </Button>
              <Button onClick={clearSelection} variant="ghost" size="sm">
                Clear Selection
              </Button>
            </div>
          </div>
        )}

        <DataTableCard<JobRow>
          title="Job History"
          icon={Briefcase}
          actions={filterBar}
          columns={columns}
          rows={filteredJobs as JobRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Briefcase}
              title={search ? 'No jobs match your search' : 'No jobs yet'}
              description={search ? 'Try adjusting your search or filters' : 'Create your first job or test routing to get started'}
              action={
                !search ? (
                  <div className="flex gap-3 justify-center">
                    <Link href="/routing">
                      <Button variant="outline" size="sm">Test Routing</Button>
                    </Link>
                    <Button variant="gradient" size="sm" onClick={() => setShowCreateModal(true)}>
                      Create Job
                    </Button>
                  </div>
                ) : undefined
              }
            />
          }
          pagination={pagination ? {
            page,
            pageSize: pagination.limit,
            total: pagination.total,
            onPageChange: setPage,
          } : undefined}
        />
      </div>

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
    </DashboardShell>
  )
}
