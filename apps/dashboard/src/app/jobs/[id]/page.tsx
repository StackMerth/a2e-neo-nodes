'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Briefcase, Clock,
  Route, ArrowLeft, Server, DollarSign,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

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
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nodes, setNodes] = useState<NodeOption[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string>('')
  const [assigning, setAssigning] = useState(false)

  const [durationHours, setDurationHours] = useState<string>('2')
  const [completing, setCompleting] = useState(false)

  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  useEffect(() => {
    loadJob()
    loadNodes()
    const interval = setInterval(() => {
      if (job && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
        loadJob()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [jobId])

  async function loadJob(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    try {
      const data = await api.jobs.get(jobId) as unknown as JobDetail
      setJob(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job')
    } finally {
      setLoading(false)
      setRefreshing(false)
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

  if (loading || error || !job) {
    return (
      <DashboardShell title="Job" subtitle="Loading...">
        <div className="lg:col-span-3">
          <Link href="/jobs" className="text-accent hover:underline text-sm mb-4 inline-block">
            Back to Jobs
          </Link>
          <SectionCard>
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
              {error || 'Loading job...'}
            </p>
            {error && (
              <div className="text-center">
                <Button onClick={() => router.push('/jobs')} variant="outline" className="mt-4">
                  Return to Jobs
                </Button>
              </div>
            )}
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  const currentStepIndex = job.status === 'FAILED' || job.status === 'CANCELLED'
    ? -1
    : STATUS_STEPS.indexOf(job.status)

  return (
    <DashboardShell
      title={`Job: ${job.id.slice(0, 8)}`}
      subtitle={job.status}
      onRefresh={() => loadJob(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <Link href="/jobs" className="inline-flex items-center gap-1.5 text-sm hover:text-accent transition-colors -mt-2" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} />
          Back to Jobs
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg text-sm font-medium border ${getMarketColor(job.market)}`}>
            <span className={`w-2 h-2 rounded-full ${getStatusColor(job.status).split(' ')[0]}`} />
            {job.status}
          </span>
          <div className="flex-1" />
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
            <Button onClick={() => handleJobAction('retry')} disabled={actionInProgress === 'retry'} variant="primary" size="sm">
              {actionInProgress === 'retry' ? 'Retrying...' : 'Retry Job'}
            </Button>
          )}
          {canPerformAction('requeue') && (
            <Button onClick={() => handleJobAction('requeue')} disabled={actionInProgress === 'requeue'} variant="secondary" size="sm">
              {actionInProgress === 'requeue' ? 'Requeuing...' : 'Requeue'}
            </Button>
          )}
        </div>

        <MetricTriad
          metrics={[
            {
              label: 'Market',
              value: job.market || 'PENDING',
              icon: Route,
              tone: 'blue',
            },
            {
              label: 'Duration',
              value: job.timing.durationSeconds ? `${Math.round(job.timing.durationSeconds / 60)}m` : '-',
              icon: Clock,
              tone: 'purple',
            },
            {
              label: 'Earnings',
              value: `$${job.earnings?.toFixed(4) || '0'}`,
              detail: job.profit ? `${(job.profit >= 0 ? '+' : '') + '$' + job.profit.toFixed(4)} profit` : undefined,
              icon: DollarSign,
              tone: 'orange',
            },
          ]}
        />

        <SectionCard title="Job Timeline" icon={Clock}>
          <div className="mb-4">
            <div className="flex items-center justify-between relative">
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
                      'bg-surface border-2 border-border'
                    }`} style={(!isCompleted && !isCurrent && !isFailed) ? { color: 'var(--text-muted)' } : undefined}>
                      {isFailed ? '!' : isCompleted ? 'OK' : index + 1}
                    </div>
                    <span className={`text-xs mt-2`} style={{ color: isCompleted || isCurrent ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {step}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-border">
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Requested</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{new Date(job.timing.requestedAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Routed</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {job.timing.routedAt ? new Date(job.timing.routedAt).toLocaleString() : '-'}
              </p>
            </div>
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Started</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {job.timing.startedAt ? new Date(job.timing.startedAt).toLocaleString() : '-'}
              </p>
            </div>
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Completed</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {job.timing.completedAt ? new Date(job.timing.completedAt).toLocaleString() : '-'}
              </p>
            </div>
          </div>
        </SectionCard>

        {(job.cost != null || job.profit != null) && (
          <SectionCard title="Job Financials" icon={DollarSign}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-background rounded-lg">
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Earnings</p>
                <p className="text-xl font-bold text-accent">${job.earnings?.toFixed(4) || '0'}</p>
              </div>
              <div className="p-4 bg-background rounded-lg">
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Cost</p>
                <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>${job.cost?.toFixed(4) || '0'}</p>
              </div>
              <div className="p-4 bg-background rounded-lg">
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Profit</p>
                <p className={`text-xl font-bold ${(job.profit ?? 0) >= 0 ? 'text-accent' : 'text-error'}`}>
                  {(job.profit ?? 0) >= 0 ? '+' : ''}${job.profit?.toFixed(4) || '0'}
                </p>
              </div>
              <div className="p-4 bg-background rounded-lg">
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Profit Margin</p>
                <p className={`text-xl font-bold ${
                  job.earnings && job.earnings > 0
                    ? ((job.profit ?? 0) / job.earnings) >= 0 ? 'text-accent' : 'text-error'
                    : ''
                }`} style={(!job.earnings || job.earnings === 0) ? { color: 'var(--text-muted)' } : undefined}>
                  {job.earnings && job.earnings > 0
                    ? `${(((job.profit ?? 0) / job.earnings) * 100).toFixed(1)}%`
                    : 'N/A'}
                </p>
              </div>
            </div>

            {job.market && job.market !== 'INTERNAL' && (
              <div className="mt-4 p-4 bg-accent/5 border border-accent/20 rounded-xl">
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <strong className="text-accent">Note:</strong> Cost is calculated based on the {job.market} market rate at the time of job completion.
                </p>
              </div>
            )}
          </SectionCard>
        )}

        {job.routingLog && (
          <SectionCard title="Routing Decision" icon={Route}>
            <div className="space-y-4">
              <div className="p-4 bg-background rounded-lg">
                <div className="flex items-center justify-between mb-3">
                  <span style={{ color: 'var(--text-muted)' }}>Selected Market</span>
                  <span className={`px-4 py-2 rounded-lg font-bold ${getMarketColor(job.routingLog.selectedMarket)}`}>
                    {job.routingLog.selectedMarket}
                  </span>
                </div>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{job.routingLog.reason}</p>
              </div>

              <div className="space-y-3">
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Rate Comparison</p>

                <div className="flex items-center justify-between p-3 bg-background rounded-lg">
                  <span className="text-accent font-medium">Internal</span>
                  <span style={{ color: 'var(--text-primary)' }}>${(job.routingLog.internalRate * 24).toFixed(2)}/day</span>
                </div>

                {job.routingLog.akashRate !== null && (
                  <div className="flex items-center justify-between p-3 bg-background rounded-lg">
                    <span className="text-blue-400 font-medium">Akash</span>
                    <span style={{ color: 'var(--text-primary)' }}>${(job.routingLog.akashRate * 24).toFixed(2)}/day</span>
                  </div>
                )}

                {job.routingLog.ionetRate !== null && (
                  <div className="flex items-center justify-between p-3 bg-background rounded-lg">
                    <span className="text-purple-400 font-medium">IO.net</span>
                    <span style={{ color: 'var(--text-primary)' }}>${(job.routingLog.ionetRate * 24).toFixed(2)}/day</span>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 bg-surface-hover rounded-lg border border-border">
                  <span style={{ color: 'var(--text-muted)' }}>Yield Floor</span>
                  <div className="text-right">
                    <span style={{ color: 'var(--text-primary)' }}>${(job.routingLog.yieldFloor * 24).toFixed(2)}/day</span>
                    {job.routingLog.yieldFloorApplied && (
                      <span className="ml-2 px-2 py-0.5 bg-warning/10 text-warning text-xs rounded">APPLIED</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between text-sm pt-3 border-t border-border" style={{ color: 'var(--text-muted)' }}>
                <span>Decision Time: {job.routingLog.decisionTimeMs}ms</span>
                <span>{new Date(job.routingLog.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </SectionCard>
        )}

        {job.errorMessage && (
          <SectionCard title="Error Details">
            <div className="p-4 bg-error/10 rounded-lg">
              <p className="text-error font-mono text-sm">{job.errorMessage}</p>
            </div>
            {job.retryCount > 0 && (
              <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                This job has been retried {job.retryCount} time{job.retryCount > 1 ? 's' : ''}.
              </p>
            )}
          </SectionCard>
        )}

        {job.node && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && (
          <SectionCard title="Complete Job" icon={Briefcase}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Duration (hours)</label>
                <input
                  type="number"
                  value={durationHours}
                  onChange={(e) => setDurationHours(e.target.value)}
                  step="0.5"
                  min="0.1"
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:border-accent"
                  style={{ color: 'var(--text-primary)' }}
                  placeholder="e.g., 2.5"
                />
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Estimated earnings: ${((parseFloat(durationHours) || 0) * (job.ratePerHour || 0)).toFixed(2)}
                </p>
              </div>
              <Button onClick={handleCompleteJob} disabled={completing} variant="gradient" className="w-full">
                {completing ? 'Completing...' : 'Complete Job & Calculate Earnings'}
              </Button>
            </div>
          </SectionCard>
        )}
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Assigned Node" icon={Server}>
          {job.node ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${
                    job.node.status === 'ONLINE' ? 'bg-accent' :
                    job.node.status === 'DEGRADED' ? 'bg-warning' : 'bg-error'
                  }`} />
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{job.node.status}</span>
                </div>
                <span className="px-2 py-1 bg-accent/10 text-accent text-sm rounded">{job.node.gpuTier}</span>
              </div>

              <div className="p-3 bg-background rounded-lg">
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Wallet Address</p>
                <p className="text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>{job.node.walletAddress}</p>
              </div>

              <div className="p-3 bg-background rounded-lg">
                <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Node ID</p>
                <p className="text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>{job.node.id}</p>
              </div>

              <Link href={`/nodes/${job.node.id}`}>
                <Button variant="secondary" className="w-full">
                  View Node Details
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No node assigned yet. Select a node to assign:</p>

              <select
                value={selectedNodeId}
                onChange={(e) => setSelectedNodeId(e.target.value)}
                className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:border-accent"
                style={{ color: 'var(--text-primary)' }}
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

              <Button onClick={handleAssignNode} disabled={!selectedNodeId || assigning} variant="gradient" className="w-full">
                {assigning ? 'Assigning...' : 'Assign Node'}
              </Button>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Job Information" icon={Briefcase}>
          <div className="space-y-3">
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Job ID</p>
              <p className="text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>{job.id}</p>
            </div>
            <div>
              <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Deployment ID</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{job.deploymentId}</p>
            </div>
            <div className="flex justify-between">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>GPU Tier</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{job.gpuTier}</p>
            </div>
            <div className="flex justify-between">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Rate per Hour</p>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>${job.ratePerHour?.toFixed(4) || '0'}</p>
            </div>
          </div>
        </SectionCard>
      </DashboardRightRail>
    </DashboardShell>
  )
}
