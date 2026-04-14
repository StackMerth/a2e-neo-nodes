'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'

interface NodeDetail {
  id: string; walletAddress: string; gpuTier: string; nodeType: string; status: string
  region: string | null; agentVersion: string | null; currentJobId: string | null
  lastHeartbeat: string; customGpuModel: string | null; customRatePerHour: number | null; createdAt: string
  heartbeats: Array<{ id: string; gpuUtilization: number | null; gpuTemperature: number | null; gpuMemoryUsed: number | null; gpuMemoryTotal: number | null; timestamp: string }>
  jobs: Array<{ id: string; status: string; market: string | null; earnings: number | null; durationSeconds: number | null; createdAt: string; completedAt: string | null }>
}

export default function NodeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<{ node: NodeDetail; uptimeEarnings: { earnings: number; uptimeHours: number } } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => { loadData() }, [id])

  async function loadData() {
    try {
      const d = await nodeRunner.node(id) as { node: NodeDetail; uptimeEarnings: { earnings: number; uptimeHours: number } }
      setData(d)
    } catch { toast('error', 'Failed to load node') }
    finally { setLoading(false) }
  }

  async function handleStatusChange(status: string) {
    setActionLoading(true)
    try {
      await nodeRunner.updateNode(id, { status })
      toast('success', `Node ${status.toLowerCase()}`)
      await loadData()
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed') }
    finally { setActionLoading(false) }
  }

  async function handleDelete() {
    setActionLoading(true)
    try {
      await nodeRunner.deleteNode(id)
      toast('success', 'Node marked for removal')
      router.push('/nodes')
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed') }
    finally { setActionLoading(false); setShowDeleteModal(false) }
  }

  if (loading) return <div className="space-y-4 animate-fadeIn">{[1,2,3].map(i => <Skeleton key={i} className="h-40" />)}</div>
  if (!data) return <div className="text-center py-20 text-text-muted">Node not found</div>

  const { node, uptimeEarnings } = data
  const lastHb = node.heartbeats[0]

  const statusColors: Record<string, string> = {
    ONLINE: 'bg-accent/10 text-accent', OFFLINE: 'bg-error/10 text-error', DEGRADED: 'bg-warning/10 text-warning',
    PAUSED: 'bg-surface-hover text-text-muted', MAINTENANCE: 'bg-info/10 text-info',
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/nodes" className="text-sm text-text-muted hover:text-text-secondary mb-1 inline-block">&larr; Back to Nodes</Link>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
            {node.customGpuModel || node.gpuTier} Node
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColors[node.status] ?? ''}`}>{node.status}</span>
          </h1>
        </div>
        <div className="flex gap-2">
          {node.status === 'ONLINE' && <Button variant="secondary" size="sm" onClick={() => handleStatusChange('PAUSED')} loading={actionLoading}>Pause</Button>}
          {node.status === 'PAUSED' && <Button size="sm" onClick={() => handleStatusChange('ONLINE')} loading={actionLoading}>Resume</Button>}
          {node.status !== 'MAINTENANCE' && <Button variant="secondary" size="sm" onClick={() => handleStatusChange('MAINTENANCE')} loading={actionLoading}>Maintenance</Button>}
          <Button variant="danger" size="sm" onClick={() => setShowDeleteModal(true)}>Remove</Button>
        </div>
      </div>

      {/* Specs + Earnings */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5">
          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Specifications</h3>
          <div className="space-y-2 text-sm">
            <Row label="GPU Tier" value={node.gpuTier} />
            <Row label="Type" value={node.nodeType} />
            <Row label="Region" value={node.region ?? 'Unknown'} />
            <Row label="Agent" value={node.agentVersion ?? 'Unknown'} />
            <Row label="Registered" value={new Date(node.createdAt).toLocaleDateString()} />
          </div>
        </Card>
        <Card className="p-5">
          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">Performance (30d)</h3>
          <div className="space-y-2 text-sm">
            <Row label="Uptime" value={`${uptimeEarnings.uptimeHours.toFixed(1)} hrs`} />
            <Row label="Earnings" value={`$${uptimeEarnings.earnings.toFixed(2)}`} />
            <Row label="Last Heartbeat" value={node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleTimeString() : 'Never'} />
          </div>
        </Card>
        <Card className="p-5">
          <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">GPU Metrics</h3>
          {lastHb ? (
            <div className="space-y-2 text-sm">
              <Row label="Temperature" value={lastHb.gpuTemperature != null ? `${lastHb.gpuTemperature}\u00b0C` : 'N/A'} />
              <Row label="GPU Util" value={lastHb.gpuUtilization != null ? `${lastHb.gpuUtilization}%` : 'N/A'} />
              <Row label="Memory" value={lastHb.gpuMemoryUsed != null && lastHb.gpuMemoryTotal != null ? `${(lastHb.gpuMemoryUsed / 1024).toFixed(1)} / ${(lastHb.gpuMemoryTotal / 1024).toFixed(1)} GB` : 'N/A'} />
            </div>
          ) : <p className="text-sm text-text-muted">No metrics available</p>}
        </Card>
      </div>

      {/* Recent Jobs */}
      <Card className="p-6">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Recent Jobs</h3>
        {node.jobs.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">No jobs executed yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-text-muted text-xs uppercase tracking-wider border-b border-border">
                <th className="text-left py-2 font-medium">Job ID</th><th className="text-left py-2 font-medium">Status</th>
                <th className="text-left py-2 font-medium">Market</th><th className="text-right py-2 font-medium">Earnings</th>
                <th className="text-right py-2 font-medium">Duration</th><th className="text-right py-2 font-medium">Date</th>
              </tr></thead>
              <tbody>
                {node.jobs.map(job => (
                  <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                    <td className="py-2.5 font-mono text-xs text-text-secondary">{job.id.slice(0, 8)}</td>
                    <td className="py-2.5"><JobBadge status={job.status} /></td>
                    <td className="py-2.5 text-text-secondary">{job.market ?? '-'}</td>
                    <td className="py-2.5 text-right text-text-primary font-medium">{job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-'}</td>
                    <td className="py-2.5 text-right text-text-secondary">{job.durationSeconds != null ? `${Math.floor(job.durationSeconds / 60)}m ${job.durationSeconds % 60}s` : '-'}</td>
                    <td className="py-2.5 text-right text-text-muted text-xs">{new Date(job.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Delete Modal */}
      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Remove Node">
        <p className="text-text-secondary text-sm mb-4">Are you sure you want to remove this node? The agent will be uninstalled on the next heartbeat.</p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} loading={actionLoading}>Remove Node</Button>
        </div>
      </Modal>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary font-medium">{value}</span>
    </div>
  )
}

function JobBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    COMPLETED: 'bg-accent/10 text-accent', FAILED: 'bg-error/10 text-error', RUNNING: 'bg-accent-blue/10 text-accent-blue',
    PENDING: 'bg-surface-hover text-text-muted', CANCELLED: 'bg-surface-hover text-text-muted',
  }
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${colors[status] ?? colors.PENDING}`}>{status}</span>
}
