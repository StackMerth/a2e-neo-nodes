'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Server, Cpu, Clock, ArrowLeft,
  Heart, HeartPulse, Pause, Play, Trash2, Pencil,
  Briefcase, CheckCircle, AlertCircle, X,
  FileText, DollarSign,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ProgressBar, CircularProgress } from '@/components/ui/ProgressBar'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

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
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [statementDays, setStatementDays] = useState(30)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [editWalletOpen, setEditWalletOpen] = useState(false)
  const [newWalletAddress, setNewWalletAddress] = useState('')

  useEffect(() => {
    loadNode()
  }, [nodeId])

  async function loadNode(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    try {
      const data = await api.nodes.get(nodeId) as unknown as NodeDetail
      setNode(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load node')
    } finally {
      setLoading(false)
      setRefreshing(false)
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

  function handleDelete() {
    setDeleteModalOpen(true)
  }

  async function confirmDelete() {
    setDeleteModalOpen(false)
    setActionLoading('delete')
    try {
      await api.nodes.delete(nodeId)
      router.push('/nodes')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setActionLoading(null)
    }
  }

  function openEditWallet() {
    setNewWalletAddress(node?.walletAddress || '')
    setEditWalletOpen(true)
  }

  async function handleUpdateWallet() {
    if (!newWalletAddress.trim()) return
    setActionLoading('wallet')
    try {
      await api.nodes.update(nodeId, { walletAddress: newWalletAddress.trim() })
      await loadNode()
      setEditWalletOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update wallet address')
    } finally {
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

  if (error && !node) {
    return (
      <DashboardShell title="Node Not Found" subtitle="Detail view">
        <div className="lg:col-span-3">
          <Link href="/nodes" className="inline-flex items-center gap-2 mb-4 hover:text-accent transition-colors" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft size={16} />
            <span>Back to Nodes</span>
          </Link>
          <SectionCard>
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-2xl bg-error/10 flex items-center justify-center mx-auto mb-4">
                <AlertCircle size={32} className="text-error" />
              </div>
              <h2 className="font-display text-lg mb-2" style={{ color: 'var(--text-primary)' }}>Node Not Found</h2>
              <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>{error || 'The requested node could not be found.'}</p>
              <Button onClick={() => router.push('/nodes')} variant="gradient">
                Return to Nodes
              </Button>
            </div>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  if (loading || !node) {
    return (
      <DashboardShell title="Loading..." subtitle="Detail view">
        <div className="lg:col-span-3">
          <SectionCard>
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading...</p>
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  const latestHeartbeat = node.heartbeats?.[0]
  const completedJobs = node.jobs?.filter(j => j.status === 'COMPLETED') || []
  const totalEarnings = completedJobs.reduce((sum, j) => {
    if (!j.ratePerHour || !j.completedAt || !j.requestedAt) return sum
    const hours = (new Date(j.completedAt).getTime() - new Date(j.requestedAt).getTime()) / (1000 * 60 * 60)
    return sum + (hours * j.ratePerHour)
  }, 0)

  const getTempVariant = (temp: number): 'accent' | 'orange' | 'purple' => {
    if (temp > 80) return 'purple'
    if (temp > 70) return 'orange'
    return 'accent'
  }

  return (
    <DashboardShell
      title={`Node: ${node.gpuTier}`}
      subtitle={node.id.slice(0, 12)}
      onRefresh={() => loadNode(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <Link href="/nodes" className="inline-flex items-center gap-1.5 text-sm hover:text-accent transition-colors -mt-2" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={16} />
          Back to Nodes
        </Link>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg text-sm font-medium border ${getStatusBadgeStyle(node.status)}`}>
            <span className={`w-2 h-2 rounded-full ${getStatusDotColor(node.status)}`} />
            {node.status}
          </span>
          <div className="flex-1" />
          <Button variant="gradient" onClick={handleHeartbeat} loading={actionLoading === 'heartbeat'} icon={<Heart size={16} />}>
            Heartbeat
          </Button>
          {node.status === 'ONLINE' && (
            <Button variant="secondary" onClick={() => handleStatusChange('PAUSED')} loading={actionLoading === 'status'} icon={<Pause size={16} />}>
              Pause
            </Button>
          )}
          {node.status === 'PAUSED' && (
            <Button variant="secondary" onClick={() => handleStatusChange('ONLINE')} loading={actionLoading === 'status'} icon={<Play size={16} />}>
              Resume
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={handleDelete}
            loading={actionLoading === 'delete'}
            className="text-error hover:text-error hover:bg-error/10"
            icon={<Trash2 size={16} />}
          >
            Delete
          </Button>
        </div>

        {error && (
          <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
              <AlertCircle size={16} className="text-error" />
            </div>
            <p className="text-error text-sm">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto text-error/60 hover:text-error">
              <X size={16} />
            </button>
          </div>
        )}

        <MetricTriad
          metrics={[
            {
              label: 'Uptime Hours',
              value: node.heartbeats?.length > 0 ? `${(node.heartbeats.length * 5 / 60).toFixed(0)}h` : '0h',
              icon: Clock,
              tone: 'blue',
            },
            {
              label: 'Total Earnings',
              value: `$${totalEarnings.toFixed(2)}`,
              icon: DollarSign,
              tone: 'orange',
            },
            {
              label: 'Jobs Completed',
              value: String(completedJobs.length),
              detail: `${node.jobs?.length ?? 0} total`,
              icon: CheckCircle,
              tone: 'purple',
            },
          ]}
        />

        <SectionCard title="GPU Metrics" icon={Cpu} badge={
          latestHeartbeat ? (
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] ml-2" style={{ color: 'var(--text-muted)' }}>
              Updated {new Date(latestHeartbeat.timestamp).toLocaleString()}
            </span>
          ) : undefined
        }>
          {latestHeartbeat ? (
            <div className="space-y-6">
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm" style={{ color: 'var(--text-muted)' }}>GPU Utilization</span>
                  <span className="text-sm font-semibold text-accent tabular-nums">
                    {latestHeartbeat.gpuUtilization ?? 'N/A'}%
                  </span>
                </div>
                <ProgressBar value={latestHeartbeat.gpuUtilization || 0} variant="accent" size="md" animate />
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm" style={{ color: 'var(--text-muted)' }}>GPU Temperature</span>
                  <span className={`text-sm font-semibold tabular-nums ${
                    (latestHeartbeat.gpuTemperature || 0) > 80 ? 'text-error' :
                    (latestHeartbeat.gpuTemperature || 0) > 70 ? 'text-warning' : 'text-accent'
                  }`}>
                    {latestHeartbeat.gpuTemperature ?? 'N/A'}C
                  </span>
                </div>
                <ProgressBar value={Math.min((latestHeartbeat.gpuTemperature || 0), 100)} variant={getTempVariant(latestHeartbeat.gpuTemperature || 0)} size="md" animate />
              </div>

              {latestHeartbeat.memoryUsed && latestHeartbeat.memoryTotal && (
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Memory Usage</span>
                    <span className="text-sm font-semibold text-accent-blue tabular-nums">
                      {(latestHeartbeat.memoryUsed / 1024).toFixed(1)} / {(latestHeartbeat.memoryTotal / 1024).toFixed(1)} GB
                    </span>
                  </div>
                  <ProgressBar value={(latestHeartbeat.memoryUsed / latestHeartbeat.memoryTotal) * 100} variant="blue" size="md" animate />
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 pt-4 border-t border-border/50">
                <div className="text-center">
                  <CircularProgress value={latestHeartbeat.gpuUtilization || 0} variant="accent" size={64} strokeWidth={6} />
                  <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>GPU</p>
                </div>
                <div className="text-center">
                  <CircularProgress value={latestHeartbeat.gpuTemperature || 0} variant={getTempVariant(latestHeartbeat.gpuTemperature || 0)} size={64} strokeWidth={6} />
                  <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Temp</p>
                </div>
                {latestHeartbeat.memoryUsed && latestHeartbeat.memoryTotal && (
                  <div className="text-center">
                    <CircularProgress value={(latestHeartbeat.memoryUsed / latestHeartbeat.memoryTotal) * 100} variant="blue" size={64} strokeWidth={6} />
                    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Memory</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4">
                <Cpu size={32} style={{ color: 'var(--text-muted)' }} />
              </div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No heartbeat data available</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Send a heartbeat to see GPU metrics</p>
            </div>
          )}
        </SectionCard>

        {node.heartbeats && node.heartbeats.length > 0 && (
          <SectionCard title="Heartbeat History" icon={HeartPulse} badge={
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] ml-2" style={{ color: 'var(--text-muted)' }}>
              Last {node.heartbeats.length}
            </span>
          }>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[500px]">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Time</th>
                    <th className="text-right py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>GPU Usage</th>
                    <th className="text-right py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Temperature</th>
                    <th className="text-right py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Memory</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {node.heartbeats.slice(0, 10).map((hb) => (
                    <tr key={hb.id} className="hover:bg-surface-hover/50 transition-colors">
                      <td className="py-4 px-4">
                        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                          {new Date(hb.timestamp).toLocaleString()}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16">
                            <ProgressBar value={hb.gpuUtilization || 0} variant="accent" size="sm" />
                          </div>
                          <span className="text-sm font-medium tabular-nums w-12 text-right" style={{ color: 'var(--text-primary)' }}>
                            {hb.gpuUtilization ?? '-'}%
                          </span>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <span className={`text-sm font-medium tabular-nums ${
                          (hb.gpuTemperature || 0) > 80 ? 'text-error' :
                          (hb.gpuTemperature || 0) > 70 ? 'text-warning' : ''
                        }`} style={(hb.gpuTemperature || 0) > 70 ? undefined : { color: 'var(--text-primary)' }}>
                          {hb.gpuTemperature ?? '-'}C
                        </span>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
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
          </SectionCard>
        )}

        <SectionCard title="Job History" icon={Briefcase} badge={
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] ml-2" style={{ color: 'var(--text-muted)' }}>
            {node.jobs?.length || 0} jobs
          </span>
        }>
          {node.jobs && node.jobs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Deployment</th>
                    <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Status</th>
                    <th className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Market</th>
                    <th className="text-right py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Rate</th>
                    <th className="text-right py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Requested</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {node.jobs.slice(0, 20).map((job) => (
                    <tr key={job.id} className="hover:bg-surface-hover/50 transition-colors">
                      <td className="py-4 px-4">
                        <Link href={`/jobs/${job.id}`} className="text-sm font-medium text-accent hover:text-accent/80 transition-colors">
                          {job.deploymentId}
                        </Link>
                      </td>
                      <td className="py-4 px-4">
                        <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium border ${getJobStatusStyle(job.status)}`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                        <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium border ${getMarketStyle(job.market)}`}>
                          {job.market || 'PENDING'}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <span className="text-sm font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {job.ratePerHour ? `$${(job.ratePerHour * 24).toFixed(2)}/day` : '-'}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <span className="text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
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
                <Briefcase size={32} style={{ color: 'var(--text-muted)' }} />
              </div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No jobs processed by this node yet</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Jobs will appear here once routing begins</p>
            </div>
          )}
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Node Information" icon={Server}>
          <div className="space-y-4">
            <InfoRow label="Node ID" value={node.id} mono />
            <InfoRow label="GPU Tier" value={node.gpuTier} badge badgeColor="accent" />
            <InfoRow label="Node Type" value={node.nodeType} />
            <div className="flex justify-between items-center py-3 border-b border-border/50">
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Wallet</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{node.walletAddress.slice(0, 8)}...{node.walletAddress.slice(-4)}</span>
                <button
                  onClick={openEditWallet}
                  className="p-1 hover:text-accent hover:bg-accent/10 rounded transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  title="Edit wallet address"
                >
                  <Pencil size={14} />
                </button>
              </div>
            </div>
            <InfoRow label="Region" value={node.region || 'Not specified'} />
            <InfoRow label="Registered" value={new Date(node.createdAt).toLocaleDateString()} noBorder />
          </div>
        </SectionCard>

        <SectionCard title="Statement" icon={FileText}>
          <div className="space-y-3">
            <select
              value={statementDays}
              onChange={(e) => setStatementDays(Number(e.target.value))}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              style={{ color: 'var(--text-primary)' }}
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={handleGenerateStatement}
              loading={actionLoading === 'statement'}
              icon={<FileText size={14} />}
            >
              Generate Statement
            </Button>
          </div>
        </SectionCard>
      </DashboardRightRail>

      <Modal
        isOpen={editWalletOpen}
        onClose={() => setEditWalletOpen(false)}
        title="Edit Wallet Address"
        size="md"
      >
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
          Enter the Solana wallet address where earnings should be paid.
        </p>
        <Input
          label="Wallet Address"
          value={newWalletAddress}
          onChange={(e) => setNewWalletAddress(e.target.value)}
          placeholder="Enter Solana wallet address..."
          className="mb-4"
        />
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setEditWalletOpen(false)} className="flex-1">
            Cancel
          </Button>
          <Button variant="gradient" onClick={handleUpdateWallet} loading={actionLoading === 'wallet'} className="flex-1">
            Save
          </Button>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={confirmDelete}
        title="Delete Node"
        message="Are you sure you want to delete this node? If this is a provisioned node, the agent will be uninstalled on the next heartbeat. This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        loading={actionLoading === 'delete'}
      />
    </DashboardShell>
  )
}

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
      <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{label}</span>
      {badge ? (
        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${badgeColors[badgeColor]}`}>
          {value}
        </span>
      ) : (
        <span className={`text-sm ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--text-primary)' }}>{value}</span>
      )}
    </div>
  )
}
