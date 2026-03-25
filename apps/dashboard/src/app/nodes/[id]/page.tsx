'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
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

export default function NodeDetailPage() {
  const params = useParams()
  const router = useRouter()
  const nodeId = params.id as string

  const [node, setNode] = useState<NodeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

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

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'bg-accent'
      case 'DEGRADED': return 'bg-warning'
      case 'OFFLINE': return 'bg-error'
      default: return 'bg-text-muted'
    }
  }

  const getStatusBgColor = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'bg-accent/10 text-accent border-accent/20'
      case 'DEGRADED': return 'bg-warning/10 text-warning border-warning/20'
      case 'OFFLINE': return 'bg-error/10 text-error border-error/20'
      default: return 'bg-surface text-text-muted'
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-text-muted">Loading node...</div>
      </div>
    )
  }

  if (error || !node) {
    return (
      <div className="space-y-4">
        <Link href="/nodes" className="text-accent hover:underline text-sm">
          &larr; Back to Nodes
        </Link>
        <Card className="border-error">
          <p className="text-error">{error || 'Node not found'}</p>
          <Button onClick={() => router.push('/nodes')} variant="outline" className="mt-4">
            Return to Nodes
          </Button>
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

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link href="/nodes" className="text-text-muted hover:text-accent">
          Nodes
        </Link>
        <span className="text-text-muted">/</span>
        <span className="text-text-primary">{node.id.slice(0, 8)}...</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className={`w-3 h-3 rounded-full ${getStatusColor(node.status)}`} />
            <h1 className="text-2xl font-bold text-text-primary">{node.gpuTier} Node</h1>
            <span className={`px-3 py-1 rounded-full text-sm font-medium border ${getStatusBgColor(node.status)}`}>
              {node.status}
            </span>
          </div>
          <p className="text-text-muted font-mono text-sm">{node.walletAddress}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleHeartbeat}
            loading={actionLoading === 'heartbeat'}
          >
            Send Heartbeat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            loading={actionLoading === 'delete'}
            className="text-error hover:text-error"
          >
            Delete Node
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Jobs"
          value={node._count?.jobs || 0}
        />
        <StatCard
          label="Completed Jobs"
          value={completedJobs.length}
        />
        <StatCard
          label="Avg GPU Usage"
          value={avgUtilization.toFixed(0)}
          suffix="%"
        />
        <StatCard
          label="Est. Earnings"
          value={totalEarnings.toFixed(2)}
          prefix="$"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Node Info */}
        <Card title="Node Information">
          <div className="space-y-4 mt-4">
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-text-muted">Node ID</span>
              <span className="text-text-primary font-mono text-sm">{node.id}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-text-muted">GPU Tier</span>
              <span className="px-2 py-1 bg-accent/10 text-accent text-sm rounded">{node.gpuTier}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-text-muted">Node Type</span>
              <span className="text-text-primary">{node.nodeType}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-text-muted">Region</span>
              <span className="text-text-primary">{node.region || 'Not specified'}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-border">
              <span className="text-text-muted">Registered</span>
              <span className="text-text-primary">{new Date(node.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-text-muted">Last Heartbeat</span>
              <span className="text-text-primary">{new Date(node.lastHeartbeat).toLocaleString()}</span>
            </div>
          </div>
        </Card>

        {/* GPU Metrics */}
        <Card title="GPU Metrics" description="From latest heartbeat">
          {latestHeartbeat ? (
            <div className="space-y-6 mt-4">
              {/* GPU Utilization */}
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-text-muted text-sm">GPU Utilization</span>
                  <span className="text-text-primary font-medium">
                    {latestHeartbeat.gpuUtilization ?? 'N/A'}%
                  </span>
                </div>
                <div className="h-3 bg-background rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all"
                    style={{ width: `${latestHeartbeat.gpuUtilization || 0}%` }}
                  />
                </div>
              </div>

              {/* Temperature */}
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-text-muted text-sm">GPU Temperature</span>
                  <span className={`font-medium ${
                    (latestHeartbeat.gpuTemperature || 0) > 80 ? 'text-error' :
                    (latestHeartbeat.gpuTemperature || 0) > 70 ? 'text-warning' : 'text-accent'
                  }`}>
                    {latestHeartbeat.gpuTemperature ?? 'N/A'}°C
                  </span>
                </div>
                <div className="h-3 bg-background rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      (latestHeartbeat.gpuTemperature || 0) > 80 ? 'bg-error' :
                      (latestHeartbeat.gpuTemperature || 0) > 70 ? 'bg-warning' : 'bg-accent'
                    }`}
                    style={{ width: `${Math.min((latestHeartbeat.gpuTemperature || 0), 100)}%` }}
                  />
                </div>
              </div>

              {/* Memory */}
              {latestHeartbeat.memoryUsed && latestHeartbeat.memoryTotal && (
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-text-muted text-sm">Memory Usage</span>
                    <span className="text-text-primary font-medium">
                      {(latestHeartbeat.memoryUsed / 1024).toFixed(1)} / {(latestHeartbeat.memoryTotal / 1024).toFixed(1)} GB
                    </span>
                  </div>
                  <div className="h-3 bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${(latestHeartbeat.memoryUsed / latestHeartbeat.memoryTotal) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-text-muted">
                Last updated: {new Date(latestHeartbeat.timestamp).toLocaleString()}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center h-32 text-text-muted">
              <p>No heartbeat data available</p>
            </div>
          )}
        </Card>
      </div>

      {/* Recent Heartbeats */}
      {node.heartbeats && node.heartbeats.length > 0 && (
        <Card title="Heartbeat History" description={`Last ${node.heartbeats.length} heartbeats`}>
          <div className="overflow-x-auto mt-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Time</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">GPU %</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Temp</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Memory</th>
                </tr>
              </thead>
              <tbody>
                {node.heartbeats.slice(0, 10).map((hb) => (
                  <tr key={hb.id} className="border-b border-border/50">
                    <td className="py-3 px-4 text-sm text-text-muted">
                      {new Date(hb.timestamp).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="text-text-primary">{hb.gpuUtilization ?? '-'}%</span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className={
                        (hb.gpuTemperature || 0) > 80 ? 'text-error' :
                        (hb.gpuTemperature || 0) > 70 ? 'text-warning' : 'text-text-primary'
                      }>
                        {hb.gpuTemperature ?? '-'}°C
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-text-muted">
                      {hb.memoryUsed && hb.memoryTotal
                        ? `${(hb.memoryUsed / 1024).toFixed(1)}/${(hb.memoryTotal / 1024).toFixed(1)} GB`
                        : '-'
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Job History */}
      <Card title="Job History" description={`${node.jobs?.length || 0} jobs processed`}>
        {node.jobs && node.jobs.length > 0 ? (
          <div className="overflow-x-auto mt-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Deployment</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Status</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Market</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Rate</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Requested</th>
                </tr>
              </thead>
              <tbody>
                {node.jobs.slice(0, 20).map((job) => (
                  <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover">
                    <td className="py-3 px-4">
                      <Link href={`/jobs/${job.id}`} className="text-sm text-accent hover:underline">
                        {job.deploymentId}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded text-xs ${
                        job.status === 'COMPLETED' ? 'bg-accent/10 text-accent' :
                        job.status === 'RUNNING' ? 'bg-blue-500/10 text-blue-400' :
                        job.status === 'FAILED' ? 'bg-error/10 text-error' :
                        'bg-surface text-text-muted'
                      }`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded text-xs ${
                        job.market === 'INTERNAL' ? 'bg-accent/10 text-accent' :
                        job.market === 'AKASH' ? 'bg-blue-500/10 text-blue-400' :
                        job.market === 'IONET' ? 'bg-purple-500/10 text-purple-400' :
                        'bg-surface text-text-muted'
                      }`}>
                        {job.market || 'PENDING'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-primary">
                      {job.ratePerHour ? `$${(job.ratePerHour * 24).toFixed(2)}/day` : '-'}
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-muted">
                      {new Date(job.requestedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-text-muted">
            <p>No jobs processed by this node yet</p>
          </div>
        )}
      </Card>
    </div>
  )
}
