'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Briefcase, CircleCheck, CircleX, Loader2, Clock, Ban, Zap,
  Route, ArrowLeft, Server, DollarSign,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVar = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface JobDetail {
  id: string
  deploymentId: string
  gpuTier: string
  status: string
  market: string | null
  ratePerHour: number | null
  node: {
    id: string
    walletAddress: string
    gpuTier: string
    status: string
  } | null
  timing: {
    requestedAt: string
    routedAt: string | null
    startedAt: string | null
    completedAt: string | null
    durationSeconds: number | null
  }
  earnings: number | null
  cost: number | null
  profit: number | null
  errorMessage: string | null
  retryCount: number
  routingLog: {
    selectedMarket: string
    selectedRate: number
    internalRate: number
    akashRate: number | null
    ionetRate: number | null
    yieldFloor: number
    yieldFloorApplied: boolean
    reason: string
    decisionTimeMs: number
    timestamp: string
  } | null
}

const STATUS_STEPS = ['PENDING', 'ROUTING', 'ASSIGNED', 'RUNNING', 'COMPLETED']

interface NodeOption {
  id: string
  walletAddress: string
  gpuTier: string
  status: string
}

export default function JobDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { addToast } = useToast()
  const jobId = params.id as string

  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Node assignment state
  const [nodes, setNodes] = useState<NodeOption[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string>('')
  const [assigning, setAssigning] = useState(false)

  // Job completion state
  const [durationHours, setDurationHours] = useState<string>('2')
  const [completing, setCompleting] = useState(false)

  // Job actions state
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  useEffect(() => {
    loadJob()
    loadNodes()
    // Auto-refresh if job is in progress
    const interval = setInterval(() => {
      if (job && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
        loadJob()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [jobId])

  async function loadJob() {
    try {
      const data = await api.jobs.get(jobId) as unknown as JobDetail
      setJob(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job')
    } finally {
      setLoading(false)
    }
  }

  async function loadNodes() {
    try {
      const data = await api.nodes.list({ status: 'ONLINE', limit: 100 })
      setNodes(data.nodes)
    } catch (err) {
      console.error('Failed to load nodes:', err)
    }
  }

  async function handleAssignNode() {
    if (!selectedNodeId) return
    setAssigning(true)
    try {
      await api.jobs.update(jobId, { nodeId: selectedNodeId })
      await loadJob()
      setSelectedNodeId('')
      addToast({ type: 'success', title: 'Node Assigned', message: 'Node successfully assigned to job' })
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to assign node' })
    } finally {
      setAssigning(false)
    }
  }

  async function handleCompleteJob() {
    const hours = parseFloat(durationHours)
    if (isNaN(hours) || hours <= 0) {
      addToast({ type: 'warning', title: 'Validation Error', message: 'Please enter a valid duration in hours' })
      return
    }

    if (!confirm(`Complete this job with ${hours} hours of work? This will calculate earnings.`)) {
      return
    }

    setCompleting(true)
    try {
      const durationSeconds = Math.round(hours * 3600)
      await api.jobs.update(jobId, { status: 'COMPLETED', durationSeconds })
      await loadJob()
      addToast({ type: 'success', title: 'Job Completed', message: 'Job marked as completed' })
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to complete job' })
    } finally {
      setCompleting(false)
    }
  }

  async function handleJobAction(action: 'cancel' | 'retry' | 'requeue') {
    const confirmMessages = {
      cancel: 'Are you sure you want to cancel this job?',
      retry: 'Are you sure you want to retry this job?',
      requeue: 'Are you sure you want to requeue this job?',
    }
    if (!confirm(confirmMessages[action])) return

    setActionInProgress(action)
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
      loadJob()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : `Failed to ${action} job` })
    } finally {
      setActionInProgress(null)
    }
  }

  const canPerformAction = (action: 'cancel' | 'retry' | 'requeue') => {
    if (!job) return false
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

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'bg-accent text-accent'
      case 'RUNNING': return 'bg-blue-500 text-blue-400'
      case 'ASSIGNED': return 'bg-purple-500 text-purple-400'
      case 'ROUTING': return 'bg-yellow-500 text-yellow-400'
      case 'PENDING': return 'bg-warning text-warning'
      case 'FAILED': return 'bg-error text-error'
      case 'CANCELLED': return 'bg-text-muted text-text-muted'
      default: return 'bg-text-muted text-text-muted'
    }
  }

  const getMarketColor = (market: string | null) => {
    switch (market) {
      case 'INTERNAL': return 'bg-accent/10 text-accent border-accent/20'
      case 'AKASH': return 'bg-blue-500/10 text-blue-400 border-blue-500/20'
      case 'IONET': return 'bg-purple-500/10 text-purple-400 border-purple-500/20'
      default: return 'bg-surface text-text-muted'
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-text-muted">Loading job...</div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="space-y-4">
        <Link href="/jobs" className="text-accent hover:underline text-sm">
          &larr; Back to Jobs
        </Link>
        <Card className="border-error">
          <p className="text-error">{error || 'Job not found'}</p>
          <Button onClick={() => router.push('/jobs')} variant="outline" className="mt-4">
            Return to Jobs
          </Button>
        </Card>
      </div>
    )
  }

  // Calculate current step index for timeline
  const currentStepIndex = job.status === 'FAILED' || job.status === 'CANCELLED'
    ? -1
    : STATUS_STEPS.indexOf(job.status)

  return (
    <motion.div className="space-y-8" variants={container} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={itemVar}>
        <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-accent transition-colors mb-4">
          <ArrowLeft size={14} />
          Back to Jobs
        </Link>
        <div className="dash-header">
          <div className="dash-header-left">
            <h1><Briefcase size={28} /> Job: {job.id.slice(0, 8)}</h1>
            <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg text-sm font-medium border ${getMarketColor(job.market)}`}>
              <span className={`w-2 h-2 rounded-full ${getStatusColor(job.status).split(' ')[0]}`} />
              {job.status}
            </span>
          </div>
          <div className="dash-header-right">
            {canPerformAction('cancel') && (
              <Button
                onClick={() => handleJobAction('cancel')}
                disabled={actionInProgress === 'cancel'}
                variant="outline"
                size="sm"
                className="border-error text-error hover:bg-error/10"
              >
                {actionInProgress === 'cancel' ? 'Cancelling...' : 'Cancel Job'}
              </Button>
            )}
            {canPerformAction('retry') && (
              <Button
                onClick={() => handleJobAction('retry')}
                disabled={actionInProgress === 'retry'}
                variant="primary"
                size="sm"
              >
                {actionInProgress === 'retry' ? 'Retrying...' : 'Retry Job'}
              </Button>
            )}
            {canPerformAction('requeue') && (
              <Button
                onClick={() => handleJobAction('requeue')}
                disabled={actionInProgress === 'requeue'}
                variant="secondary"
                size="sm"
              >
                {actionInProgress === 'requeue' ? 'Requeuing...' : 'Requeue'}
              </Button>
            )}
          </div>
        </div>
      </motion.div>

      {/* KPI Blocks */}
      <motion.div variants={itemVar} className="stat-blocks">
        <div className="stat-block green">
          <div className="stat-icon">
            <span className={`w-2.5 h-2.5 rounded-full ${getStatusColor(job.status).split(' ')[0]}`} />
          </div>
          <div className="stat-content">
            <span className="stat-value">{job.status}</span>
            <span className="stat-label">Status</span>
          </div>
        </div>
        <div className="stat-block blue">
          <div className="stat-icon"><Route size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{job.market || 'PENDING'}</span>
            <span className="stat-label">Market</span>
          </div>
        </div>
        <div className="stat-block purple">
          <div className="stat-icon"><Clock size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">{job.timing.durationSeconds ? `${Math.round(job.timing.durationSeconds / 60)}m` : '-'}</span>
            <span className="stat-label">Duration</span>
          </div>
        </div>
        <div className="stat-block orange">
          <div className="stat-icon"><DollarSign size={20} /></div>
          <div className="stat-content">
            <span className="stat-value">${job.earnings?.toFixed(4) || '0'}</span>
            <span className="stat-label">Earnings</span>
          </div>
        </div>
      </motion.div>

      {/* Status Timeline */}
      <motion.div variants={itemVar}>
      <Card title="Job Timeline">
        <div className="mt-6 mb-4">
          <div className="flex items-center justify-between relative">
            {/* Progress Line */}
            <div className="absolute top-4 left-0 right-0 h-0.5 bg-border" />
            <div
              className="absolute top-4 left-0 h-0.5 bg-accent transition-all"
              style={{
                width: currentStepIndex >= 0
                  ? `${(currentStepIndex / (STATUS_STEPS.length - 1)) * 100}%`
                  : '0%'
              }}
            />

            {STATUS_STEPS.map((step, index) => {
              const isCompleted = currentStepIndex >= index
              const isCurrent = currentStepIndex === index
              const isFailed = job.status === 'FAILED' && step === 'COMPLETED'

              return (
                <div key={step} className="flex flex-col items-center relative z-10">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    isFailed ? 'bg-error text-white' :
                    isCompleted ? 'bg-accent text-white' :
                    isCurrent ? 'bg-accent/20 text-accent border-2 border-accent' :
                    'bg-surface text-text-muted border-2 border-border'
                  }`}>
                    {isFailed ? '!' : isCompleted ? '✓' : index + 1}
                  </div>
                  <span className={`text-xs mt-2 ${
                    isCompleted || isCurrent ? 'text-text-primary' : 'text-text-muted'
                  }`}>
                    {step}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Timing Details */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-border">
          <div>
            <p className="text-xs text-text-muted mb-1">Requested</p>
            <p className="text-sm text-text-primary">{new Date(job.timing.requestedAt).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-1">Routed</p>
            <p className="text-sm text-text-primary">
              {job.timing.routedAt ? new Date(job.timing.routedAt).toLocaleString() : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-1">Started</p>
            <p className="text-sm text-text-primary">
              {job.timing.startedAt ? new Date(job.timing.startedAt).toLocaleString() : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-1">Completed</p>
            <p className="text-sm text-text-primary">
              {job.timing.completedAt ? new Date(job.timing.completedAt).toLocaleString() : '-'}
            </p>
          </div>
        </div>
      </Card>
      </motion.div>


      {/* Financials */}
      {(job.cost != null || job.profit != null) && (
        <Card title="Job Financials" description="Cost, profit, and margin analysis">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div className="p-4 bg-background rounded-lg">
              <p className="text-xs text-text-muted mb-1">Earnings</p>
              <p className="text-xl font-bold text-accent">${job.earnings?.toFixed(4) || '0'}</p>
            </div>
            <div className="p-4 bg-background rounded-lg">
              <p className="text-xs text-text-muted mb-1">Cost</p>
              <p className="text-xl font-bold text-text-primary">${job.cost?.toFixed(4) || '0'}</p>
            </div>
            <div className="p-4 bg-background rounded-lg">
              <p className="text-xs text-text-muted mb-1">Profit</p>
              <p className={`text-xl font-bold ${(job.profit ?? 0) >= 0 ? 'text-accent' : 'text-error'}`}>
                {(job.profit ?? 0) >= 0 ? '+' : ''}${job.profit?.toFixed(4) || '0'}
              </p>
            </div>
            <div className="p-4 bg-background rounded-lg">
              <p className="text-xs text-text-muted mb-1">Profit Margin</p>
              <p className={`text-xl font-bold ${
                job.earnings && job.earnings > 0
                  ? ((job.profit ?? 0) / job.earnings) >= 0 ? 'text-accent' : 'text-error'
                  : 'text-text-muted'
              }`}>
                {job.earnings && job.earnings > 0
                  ? `${(((job.profit ?? 0) / job.earnings) * 100).toFixed(1)}%`
                  : 'N/A'}
              </p>
            </div>
          </div>

          {job.market && job.market !== 'INTERNAL' && (
            <div className="mt-4 p-4 bg-accent/5 border border-accent/20 rounded-xl">
              <p className="text-sm text-text-secondary">
                <strong className="text-accent">Note:</strong> Cost is calculated based on the {job.market} market rate at the time of job completion.
              </p>
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Routing Decision */}
        {job.routingLog && (
          <Card title="Routing Decision" description="How this job was routed">
            <div className="space-y-4 mt-4">
              {/* Selected Market */}
              <div className="p-4 bg-background rounded-lg">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-text-muted">Selected Market</span>
                  <span className={`px-4 py-2 rounded-lg font-bold ${getMarketColor(job.routingLog.selectedMarket)}`}>
                    {job.routingLog.selectedMarket}
                  </span>
                </div>
                <p className="text-sm text-text-secondary">{job.routingLog.reason}</p>
              </div>

              {/* Rate Comparison */}
              <div className="space-y-3">
                <p className="text-sm text-text-muted">Rate Comparison</p>

                <div className="flex items-center justify-between p-3 bg-background rounded-lg">
                  <span className="text-accent font-medium">Internal</span>
                  <span className="text-text-primary">${(job.routingLog.internalRate * 24).toFixed(2)}/day</span>
                </div>

                {job.routingLog.akashRate !== null && (
                  <div className="flex items-center justify-between p-3 bg-background rounded-lg">
                    <span className="text-blue-400 font-medium">Akash</span>
                    <span className="text-text-primary">${(job.routingLog.akashRate * 24).toFixed(2)}/day</span>
                  </div>
                )}

                {job.routingLog.ionetRate !== null && (
                  <div className="flex items-center justify-between p-3 bg-background rounded-lg">
                    <span className="text-purple-400 font-medium">IO.net</span>
                    <span className="text-text-primary">${(job.routingLog.ionetRate * 24).toFixed(2)}/day</span>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 bg-surface-hover rounded-lg border border-border">
                  <span className="text-text-muted">Yield Floor</span>
                  <div className="text-right">
                    <span className="text-text-primary">${(job.routingLog.yieldFloor * 24).toFixed(2)}/day</span>
                    {job.routingLog.yieldFloorApplied && (
                      <span className="ml-2 px-2 py-0.5 bg-warning/10 text-warning text-xs rounded">APPLIED</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Decision Meta */}
              <div className="flex items-center justify-between text-sm text-text-muted pt-3 border-t border-border">
                <span>Decision Time: {job.routingLog.decisionTimeMs}ms</span>
                <span>{new Date(job.routingLog.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </Card>
        )}

        {/* Assigned Node */}
        <Card title="Assigned Node">
          {job.node ? (
            <div className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${
                    job.node.status === 'ONLINE' ? 'bg-accent' :
                    job.node.status === 'DEGRADED' ? 'bg-warning' : 'bg-error'
                  }`} />
                  <span className="text-text-primary font-medium">{job.node.status}</span>
                </div>
                <span className="px-2 py-1 bg-accent/10 text-accent text-sm rounded">{job.node.gpuTier}</span>
              </div>

              <div className="p-4 bg-background rounded-lg">
                <p className="text-xs text-text-muted mb-1">Wallet Address</p>
                <p className="text-sm text-text-primary font-mono break-all">{job.node.walletAddress}</p>
              </div>

              <div className="p-4 bg-background rounded-lg">
                <p className="text-xs text-text-muted mb-1">Node ID</p>
                <p className="text-sm text-text-primary font-mono break-all">{job.node.id}</p>
              </div>

              <Link href={`/nodes/${job.node.id}`}>
                <Button variant="secondary" className="w-full">
                  View Node Details
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-4 mt-4">
              <p className="text-text-muted text-sm">No node assigned yet. Select a node to assign:</p>

              <select
                value={selectedNodeId}
                onChange={(e) => setSelectedNodeId(e.target.value)}
                className="w-full px-4 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="">Select a node...</option>
                {nodes.filter(n => n.gpuTier === job.gpuTier).map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.walletAddress.slice(0, 8)}...{node.walletAddress.slice(-4)} ({node.gpuTier})
                  </option>
                ))}
              </select>

              {nodes.filter(n => n.gpuTier === job.gpuTier).length === 0 && (
                <p className="text-warning text-xs">No online {job.gpuTier} nodes available</p>
              )}

              <Button
                onClick={handleAssignNode}
                disabled={!selectedNodeId || assigning}
                variant="gradient"
                className="w-full"
              >
                {assigning ? 'Assigning...' : 'Assign Node'}
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* Job Actions - Complete Job */}
      {job.node && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && (
        <Card title="Complete Job" description="Mark this job as completed with earnings">
          <div className="space-y-4 mt-4">
            <div>
              <label className="block text-sm text-text-muted mb-2">Duration (hours)</label>
              <input
                type="number"
                value={durationHours}
                onChange={(e) => setDurationHours(e.target.value)}
                step="0.5"
                min="0.1"
                className="w-full px-4 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent"
                placeholder="e.g., 2.5"
              />
              <p className="text-xs text-text-muted mt-1">
                Estimated earnings: ${((parseFloat(durationHours) || 0) * (job.ratePerHour || 0)).toFixed(2)}
              </p>
            </div>
            <Button
              onClick={handleCompleteJob}
              disabled={completing}
              variant="gradient"
              className="w-full"
            >
              {completing ? 'Completing...' : 'Complete Job & Calculate Earnings'}
            </Button>
          </div>
        </Card>
      )}

      {/* Error Message */}
      {job.errorMessage && (
        <Card title="Error Details" className="border-error/50">
          <div className="mt-4 p-4 bg-error/10 rounded-lg">
            <p className="text-error font-mono text-sm">{job.errorMessage}</p>
          </div>
          {job.retryCount > 0 && (
            <p className="mt-3 text-sm text-text-muted">
              This job has been retried {job.retryCount} time{job.retryCount > 1 ? 's' : ''}.
            </p>
          )}
        </Card>
      )}

      {/* Job Info */}
      <Card title="Job Information">
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="p-4 bg-background rounded-lg">
            <p className="text-xs text-text-muted mb-1">Job ID</p>
            <p className="text-sm text-text-primary font-mono break-all">{job.id}</p>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <p className="text-xs text-text-muted mb-1">Deployment ID</p>
            <p className="text-sm text-text-primary">{job.deploymentId}</p>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <p className="text-xs text-text-muted mb-1">GPU Tier</p>
            <p className="text-sm text-text-primary">{job.gpuTier}</p>
          </div>
          <div className="p-4 bg-background rounded-lg">
            <p className="text-xs text-text-muted mb-1">Rate per Hour</p>
            <p className="text-sm text-text-primary">${job.ratePerHour?.toFixed(4) || '0'}</p>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}
