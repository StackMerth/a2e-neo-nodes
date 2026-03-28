'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ProgressBar, CircularProgress } from '@/components/ui/ProgressBar'
import { Skeleton, SkeletonStatCard, SkeletonCard } from '@/components/ui/Skeleton'
import { api } from '@/lib/api'

interface NodeDetail {
  id: string
  walletAddress: string
  gpuTier: string
  nodeType: string
  status: string
  region: string | null
  lastHeartbeat: string
  createdAt: string
  updatedAt: string
  heartbeats: Array<{
    id: string
    gpuUtilization: number | null
    gpuTemperature: number | null
    memoryUsed: number | null
    memoryTotal: number | null
    timestamp: string
  }>
  jobs: Array<{
    id: string
    deploymentId: string
    status: string
    market: string | null
    ratePerHour: number | null
    requestedAt: string
    completedAt: string | null
  }>
  _count: {
    jobs: number
    heartbeats: number
  }
}

// Skeleton for the detail page
function SkeletonNodeDetail() {
  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Breadcrumb skeleton */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 w-24" />
      </div>

      {/* Header skeleton */}
      <div className="relative py-8">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />
        <div className="relative">
          <div className="flex items-start justify-between">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton className="w-4 h-4 rounded-full" />
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-6 w-20 rounded-lg" />
              </div>
              <Skeleton className="h-4 w-96" />
            </div>
            <div className="flex gap-3">
              <Skeleton className="h-10 w-32 rounded-lg" />
              <Skeleton className="h-10 w-28 rounded-lg" />
            </div>
          </div>
        </div>
      </div>

      {/* Stats skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStatCard key={i} />
        ))}
      </div>

      {/* Cards skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <SkeletonCard lines={6} />
        <SkeletonCard lines={6} />
      </div>
    </div>
  )
}

export default function NodeDetailPage() {
  const params = useParams()
  const router = useRouter()
  const nodeId = params.id as string

  const [node, setNode] = useState<NodeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [statementDays, setStatementDays] = useState(30)

  useEffect(() => {
    loadNode()
  }, [nodeId])

  async function loadNode() {
    try {
      const data = await api.nodes.get(nodeId) as unknown as NodeDetail
      setNode(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load node')
    } finally {
      setLoading(false)
    }
  }

  async function handleHeartbeat() {
    setActionLoading('heartbeat')
    try {
      await api.nodes.heartbeat(nodeId, {
        gpuUtilization: Math.floor(Math.random() * 80) + 10,
        gpuTemperature: Math.floor(Math.random() * 30) + 50,
      })
      await loadNode()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Heartbeat failed')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleStatusChange(newStatus: 'ONLINE' | 'PAUSED' | 'MAINTENANCE') {
    setActionLoading('status')
    try {
      await api.nodes.updateStatus(nodeId, newStatus)
      await loadNode()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this node? This action cannot be undone.')) {
      return
    }
    setActionLoading('delete')
    try {
      await api.nodes.delete(nodeId)
      router.push('/nodes')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setActionLoading(null)
    }
  }

  async function handleGenerateStatement() {
    setActionLoading('statement')
    try {
      await api.reports.nodeStatement(nodeId, { days: statementDays })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate statement')
    } finally {
      setActionLoading(null)
    }
  }

  const getStatusDotColor = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'bg-accent shadow-[0_0_12px_rgba(34,197,94,0.6)]'
      case 'DEGRADED': return 'bg-warning shadow-[0_0_12px_rgba(245,158,11,0.6)]'
      case 'OFFLINE': return 'bg-error shadow-[0_0_12px_rgba(239,68,68,0.6)]'
      case 'PAUSED': return 'bg-text-muted'
      case 'MAINTENANCE': return 'bg-accent-blue shadow-[0_0_12px_rgba(59,130,246,0.6)]'
      default: return 'bg-text-muted'
    }
  }

  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'bg-accent/10 text-accent border-accent/20'
      case 'DEGRADED': return 'bg-warning/10 text-warning border-warning/20'
      case 'OFFLINE': return 'bg-error/10 text-error border-error/20'
      case 'PAUSED': return 'bg-surface text-text-muted border-border'
      case 'MAINTENANCE': return 'bg-accent-blue/10 text-accent-blue border-accent-blue/20'
      default: return 'bg-surface text-text-muted border-border'
    }
  }

  const getJobStatusStyle = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'bg-accent/10 text-accent border-accent/20'
      case 'RUNNING': return 'bg-accent-blue/10 text-accent-blue border-accent-blue/20'
      case 'FAILED': return 'bg-error/10 text-error border-error/20'
      case 'CANCELLED': return 'bg-warning/10 text-warning border-warning/20'
      default: return 'bg-surface text-text-muted border-border'
    }
  }

  const getMarketStyle = (market: string | null) => {
    switch (market) {
      case 'INTERNAL': return 'bg-accent/10 text-accent border-accent/20'
      case 'AKASH': return 'bg-accent-blue/10 text-accent-blue border-accent-blue/20'
      case 'IONET': return 'bg-accent-purple/10 text-accent-purple border-accent-purple/20'
      default: return 'bg-surface text-text-muted border-border'
    }
  }

  if (loading) {
    return <SkeletonNodeDetail />
  }

  if (error || !node) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Link href="/nodes" className="inline-flex items-center gap-2 text-text-muted hover:text-accent transition-colors">
          <ArrowLeftIcon className="w-4 h-4" />
          <span>Back to Nodes</span>
        </Link>

        <Card variant="glass" className="border-error/20">
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-2xl bg-error/10 flex items-center justify-center mx-auto mb-4">
              <AlertIcon className="w-8 h-8 text-error" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary mb-2">Node Not Found</h2>
            <p className="text-text-muted text-sm mb-6">{error || 'The requested node could not be found.'}</p>
            <Button onClick={() => router.push('/nodes')} variant="gradient">
              Return to Nodes
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  // Get latest heartbeat metrics
  const latestHeartbeat = node.heartbeats?.[0]
  const avgUtilization = node.heartbeats?.length > 0
    ? node.heartbeats.reduce((sum, h) => sum + (h.gpuUtilization || 0), 0) / node.heartbeats.length
    : 0
  const avgTemperature = node.heartbeats?.length > 0
    ? node.heartbeats.filter(h => h.gpuTemperature).reduce((sum, h) => sum + (h.gpuTemperature || 0), 0) / node.heartbeats.filter(h => h.gpuTemperature).length
    : 0

  // Calculate earnings from completed jobs
  const completedJobs = node.jobs?.filter(j => j.status === 'COMPLETED') || []
  const totalEarnings = completedJobs.reduce((sum, j) => {
    if (!j.ratePerHour || !j.completedAt || !j.requestedAt) return sum
    const hours = (new Date(j.completedAt).getTime() - new Date(j.requestedAt).getTime()) / (1000 * 60 * 60)
    return sum + (hours * j.ratePerHour)
  }, 0)

  // Temperature variant for progress bar
  const getTempVariant = (temp: number): 'accent' | 'orange' | 'purple' => {
    if (temp > 80) return 'purple' // Using purple as "hot" indicator
    if (temp > 70) return 'orange'
    return 'accent'
  }

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/nodes" className="inline-flex items-center gap-1.5 text-text-muted hover:text-accent transition-colors">
          <ArrowLeftIcon className="w-4 h-4" />
          <span>Nodes</span>
        </Link>
        <ChevronRightIcon className="w-4 h-4 text-text-muted" />
        <span className="text-text-primary font-medium">{node.id.slice(0, 8)}...</span>
      </nav>

      {/* Hero Header */}
      <div className="relative py-8">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
            <div>
              <div className="flex items-center gap-4 mb-3">
                <span className={`w-4 h-4 rounded-full ${getStatusDotColor(node.status)}`} />
                <h1 className="text-3xl md:text-4xl font-bold text-text-primary">{node.gpuTier} Node</h1>
                <span className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${getStatusBadgeStyle(node.status)}`}>
                  {node.status}
                </span>
              </div>
              <p className="text-text-muted font-mono text-sm mb-2">{node.walletAddress}</p>
              <div className="flex flex-wrap items-center gap-4 text-sm text-text-muted">
                <span className="flex items-center gap-1.5">
                  <CalendarIcon className="w-4 h-4" />
                  Registered {new Date(node.createdAt).toLocaleDateString()}
                </span>
                {node.region && (
                  <span className="flex items-center gap-1.5">
                    <GlobeIcon className="w-4 h-4" />
                    {node.region}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <ClockIcon className="w-4 h-4" />
                  Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="gradient"
                onClick={handleHeartbeat}
                loading={actionLoading === 'heartbeat'}
                icon={<HeartIcon className="w-4 h-4" />}
              >
                Send Heartbeat
              </Button>

              {node.status === 'ONLINE' && (
                <Button
                  variant="secondary"
                  onClick={() => handleStatusChange('PAUSED')}
                  loading={actionLoading === 'status'}
                  icon={<PauseIcon className="w-4 h-4" />}
                >
                  Pause
                </Button>
              )}

              {node.status === 'PAUSED' && (
                <Button
                  variant="secondary"
                  onClick={() => handleStatusChange('ONLINE')}
                  loading={actionLoading === 'status'}
                  icon={<PlayIcon className="w-4 h-4" />}
                >
                  Resume
                </Button>
              )}

              <div className="flex items-center gap-2">
                <select
                  value={statementDays}
                  onChange={(e) => setStatementDays(Number(e.target.value))}
                  className="px-2 py-2 bg-background border border-border rounded-lg text-xs text-text-primary"
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
                <Button
                  variant="secondary"
                  onClick={handleGenerateStatement}
                  loading={actionLoading === 'statement'}
                  icon={<DocumentIcon className="w-4 h-4" />}
                >
                  Statement
                </Button>
              </div>

              <Button
                variant="ghost"
                onClick={handleDelete}
                loading={actionLoading === 'delete'}
                className="text-error hover:text-error hover:bg-error/10"
                icon={<TrashIcon className="w-4 h-4" />}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3 animate-slideUp">
          <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
            <AlertIcon className="w-4 h-4 text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-error/60 hover:text-error">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Jobs"
          value={node._count?.jobs || 0}
          variant="blue"
          animate
          icon={<BriefcaseIcon />}
        />
        <StatCard
          label="Completed Jobs"
          value={completedJobs.length}
          variant="accent"
          animate
          icon={<CheckCircleIcon />}
          trend={node._count?.jobs ? {
            value: Math.round(completedJobs.length / node._count.jobs * 100),
            isPositive: true
          } : undefined}
        />
        <StatCard
          label="Avg GPU Usage"
          value={avgUtilization.toFixed(0)}
          suffix="%"
          variant="purple"
          animate
          icon={<ChipIcon />}
        />
        <StatCard
          label="Est. Earnings"
          value={totalEarnings.toFixed(2)}
          prefix="$"
          variant="orange"
          animate
          icon={<DollarIcon />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Node Info */}
        <Card variant="glass" hover={false}>
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
              <ServerIcon className="w-5 h-5 text-background" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary">Node Information</h3>
              <p className="text-xs text-text-muted">Configuration and details</p>
            </div>
          </div>

          <div className="space-y-4">
            <InfoRow label="Node ID" value={node.id} mono />
            <InfoRow label="GPU Tier" value={node.gpuTier} badge badgeColor="accent" />
            <InfoRow label="Node Type" value={node.nodeType} />
            <InfoRow label="Region" value={node.region || 'Not specified'} />
            <InfoRow label="Registered" value={new Date(node.createdAt).toLocaleDateString()} />
            <InfoRow label="Last Updated" value={new Date(node.updatedAt).toLocaleString()} noBorder />
          </div>
        </Card>

        {/* GPU Metrics */}
        <Card variant="glass" hover={false}>
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-purple-400 flex items-center justify-center">
              <ChipIcon className="w-5 h-5 text-background" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary">GPU Metrics</h3>
              <p className="text-xs text-text-muted">
                {latestHeartbeat ? `Updated ${new Date(latestHeartbeat.timestamp).toLocaleString()}` : 'No data available'}
              </p>
            </div>
          </div>

          {latestHeartbeat ? (
            <div className="space-y-6">
              {/* GPU Utilization */}
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm text-text-muted">GPU Utilization</span>
                  <span className="text-sm font-semibold text-accent tabular-nums">
                    {latestHeartbeat.gpuUtilization ?? 'N/A'}%
                  </span>
                </div>
                <ProgressBar
                  value={latestHeartbeat.gpuUtilization || 0}
                  variant="accent"
                  size="md"
                  animate
                />
              </div>

              {/* Temperature */}
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm text-text-muted">GPU Temperature</span>
                  <span className={`text-sm font-semibold tabular-nums ${
                    (latestHeartbeat.gpuTemperature || 0) > 80 ? 'text-error' :
                    (latestHeartbeat.gpuTemperature || 0) > 70 ? 'text-warning' : 'text-accent'
                  }`}>
                    {latestHeartbeat.gpuTemperature ?? 'N/A'}°C
                  </span>
                </div>
                <ProgressBar
                  value={Math.min((latestHeartbeat.gpuTemperature || 0), 100)}
                  variant={getTempVariant(latestHeartbeat.gpuTemperature || 0)}
                  size="md"
                  animate
                />
              </div>

              {/* Memory */}
              {latestHeartbeat.memoryUsed && latestHeartbeat.memoryTotal && (
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-text-muted">Memory Usage</span>
                    <span className="text-sm font-semibold text-accent-blue tabular-nums">
                      {(latestHeartbeat.memoryUsed / 1024).toFixed(1)} / {(latestHeartbeat.memoryTotal / 1024).toFixed(1)} GB
                    </span>
                  </div>
                  <ProgressBar
                    value={(latestHeartbeat.memoryUsed / latestHeartbeat.memoryTotal) * 100}
                    variant="blue"
                    size="md"
                    animate
                  />
                </div>
              )}

              {/* Summary Circles */}
              <div className="grid grid-cols-3 gap-4 pt-4 border-t border-border/50">
                <div className="text-center">
                  <CircularProgress
                    value={latestHeartbeat.gpuUtilization || 0}
                    variant="accent"
                    size={64}
                    strokeWidth={6}
                  />
                  <p className="text-xs text-text-muted mt-2">GPU</p>
                </div>
                <div className="text-center">
                  <CircularProgress
                    value={latestHeartbeat.gpuTemperature || 0}
                    variant={getTempVariant(latestHeartbeat.gpuTemperature || 0)}
                    size={64}
                    strokeWidth={6}
                  />
                  <p className="text-xs text-text-muted mt-2">Temp</p>
                </div>
                {latestHeartbeat.memoryUsed && latestHeartbeat.memoryTotal && (
                  <div className="text-center">
                    <CircularProgress
                      value={(latestHeartbeat.memoryUsed / latestHeartbeat.memoryTotal) * 100}
                      variant="blue"
                      size={64}
                      strokeWidth={6}
                    />
                    <p className="text-xs text-text-muted mt-2">Memory</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4">
                <ChipIcon className="w-8 h-8 text-text-muted" />
              </div>
              <p className="text-text-muted text-sm">No heartbeat data available</p>
              <p className="text-text-muted text-xs mt-1">Send a heartbeat to see GPU metrics</p>
            </div>
          )}
        </Card>
      </div>

      {/* Heartbeat History */}
      {node.heartbeats && node.heartbeats.length > 0 && (
        <Card variant="glass" hover={false}>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-blue-400 flex items-center justify-center">
                <HeartPulseIcon className="w-5 h-5 text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Heartbeat History</h3>
                <p className="text-xs text-text-muted">Last {node.heartbeats.length} heartbeats</p>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto -mx-6">
            <table className="w-full min-w-[500px]">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Time</th>
                  <th className="text-right py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">GPU Usage</th>
                  <th className="text-right py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Temperature</th>
                  <th className="text-right py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {node.heartbeats.slice(0, 10).map((hb, idx) => (
                  <tr
                    key={hb.id}
                    className="hover:bg-surface-hover/50 transition-colors"
                  >
                    <td className="py-4 px-6">
                      <span className="text-sm text-text-muted">
                        {new Date(hb.timestamp).toLocaleString()}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16">
                          <ProgressBar value={hb.gpuUtilization || 0} variant="accent" size="sm" />
                        </div>
                        <span className="text-sm font-medium text-text-primary tabular-nums w-12 text-right">
                          {hb.gpuUtilization ?? '-'}%
                        </span>
                      </div>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <span className={`text-sm font-medium tabular-nums ${
                        (hb.gpuTemperature || 0) > 80 ? 'text-error' :
                        (hb.gpuTemperature || 0) > 70 ? 'text-warning' : 'text-text-primary'
                      }`}>
                        {hb.gpuTemperature ?? '-'}°C
                      </span>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <span className="text-sm text-text-muted tabular-nums">
                        {hb.memoryUsed && hb.memoryTotal
                          ? `${(hb.memoryUsed / 1024).toFixed(1)}/${(hb.memoryTotal / 1024).toFixed(1)} GB`
                          : '-'
                        }
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Job History */}
      <Card variant="glass" hover={false}>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-400 flex items-center justify-center">
              <BriefcaseIcon className="w-5 h-5 text-background" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary">Job History</h3>
              <p className="text-xs text-text-muted">{node.jobs?.length || 0} jobs processed</p>
            </div>
          </div>
        </div>

        {node.jobs && node.jobs.length > 0 ? (
          <div className="overflow-x-auto -mx-6">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Deployment</th>
                  <th className="text-left py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
                  <th className="text-left py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Market</th>
                  <th className="text-right py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Rate</th>
                  <th className="text-right py-3 px-6 text-xs font-medium text-text-muted uppercase tracking-wider">Requested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {node.jobs.slice(0, 20).map((job) => (
                  <tr key={job.id} className="hover:bg-surface-hover/50 transition-colors">
                    <td className="py-4 px-6">
                      <Link href={`/jobs/${job.id}`} className="text-sm font-medium text-accent hover:text-accent/80 transition-colors">
                        {job.deploymentId}
                      </Link>
                    </td>
                    <td className="py-4 px-6">
                      <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium border ${getJobStatusStyle(job.status)}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="py-4 px-6">
                      <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium border ${getMarketStyle(job.market)}`}>
                        {job.market || 'PENDING'}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <span className="text-sm font-medium text-text-primary tabular-nums">
                        {job.ratePerHour ? `$${(job.ratePerHour * 24).toFixed(2)}/day` : '-'}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-right">
                      <span className="text-sm text-text-muted tabular-nums">
                        {new Date(job.requestedAt).toLocaleDateString()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4">
              <BriefcaseIcon className="w-8 h-8 text-text-muted" />
            </div>
            <p className="text-text-muted text-sm">No jobs processed by this node yet</p>
            <p className="text-text-muted text-xs mt-1">Jobs will appear here once routing begins</p>
          </div>
        )}
      </Card>
    </div>
  )
}

// Info Row Component
function InfoRow({
  label,
  value,
  mono = false,
  badge = false,
  badgeColor = 'accent',
  noBorder = false,
}: {
  label: string
  value: string
  mono?: boolean
  badge?: boolean
  badgeColor?: 'accent' | 'blue' | 'purple'
  noBorder?: boolean
}) {
  const badgeColors = {
    accent: 'bg-accent/10 text-accent border-accent/20',
    blue: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
    purple: 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
  }

  return (
    <div className={`flex justify-between items-center py-3 ${!noBorder ? 'border-b border-border/50' : ''}`}>
      <span className="text-sm text-text-muted">{label}</span>
      {badge ? (
        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${badgeColors[badgeColor]}`}>
          {value}
        </span>
      ) : (
        <span className={`text-sm text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
      )}
    </div>
  )
}

// Icons
function ArrowLeftIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
    </svg>
  )
}

function ChevronRightIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  )
}

function ServerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
    </svg>
  )
}

function AlertIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function CloseIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function CalendarIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function GlobeIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ClockIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function HeartIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
    </svg>
  )
}

function HeartPulseIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h4l2-3 2 6 2-3h4" />
    </svg>
  )
}

function PauseIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function PlayIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function TrashIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  )
}

function BriefcaseIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function CheckCircleIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ChipIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  )
}

function DollarIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function DocumentIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}
