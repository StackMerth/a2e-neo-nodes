'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Server, Cpu, Thermometer, HardDrive, Clock, MapPin, ArrowLeft,
  ChevronRight, Heart, HeartPulse, Pause, Play, Trash2, Pencil,
  Briefcase, CheckCircle, AlertCircle, X, Calendar, Globe,
  FileText, DollarSign,
} from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ProgressBar, CircularProgress } from '@/components/ui/ProgressBar'
import { Skeleton, SkeletonStatCard, SkeletonCard } from '@/components/ui/Skeleton'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVariant = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [editWalletOpen, setEditWalletOpen] = useState(false)
  const [newWalletAddress, setNewWalletAddress] = useState('')

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

  if (loading) {
    return <SkeletonNodeDetail />
  }

  if (error || !node) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Link href="/nodes" className="inline-flex items-center gap-2 text-text-muted hover:text-accent transition-colors">
          <ArrowLeft size={16} />
          <span>Back to Nodes</span>
        </Link>

        <Card variant="glass" className="border-error/20">
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-2xl bg-error/10 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={32} className="text-error" />
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
    <motion.div className="space-y-8" variants={container} initial="hidden" animate="show">
      {/* Breadcrumb */}
      <motion.nav variants={itemVariant} className="flex items-center gap-2 text-sm">
        <Link href="/nodes" className="inline-flex items-center gap-1.5 text-text-muted hover:text-accent transition-colors">
          <ArrowLeft size={16} />
          <span>Nodes</span>
        </Link>
        <ChevronRight size={16} className="text-text-muted" />
        <span className="text-text-primary font-medium">{node.id.slice(0, 8)}...</span>
      </motion.nav>

      {/* Hero Header */}
      <motion.div variants={itemVariant} className="relative py-8">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
            <div>
              <div className="flex items-center gap-4 mb-3">
                <Server size={20} className="text-text-muted" />
                <h1 className="text-3xl md:text-4xl font-bold text-text-primary">{node.gpuTier} Node</h1>
                <span className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${getStatusBadgeStyle(node.status)}`}>
                  {node.status}
                </span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-text-muted font-mono text-sm">{node.walletAddress}</p>
                <button
                  onClick={openEditWallet}
                  className="p-1 text-text-muted hover:text-accent hover:bg-accent/10 rounded transition-colors"
                  title="Edit wallet address"
                >
                  <Pencil size={16} />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm text-text-muted">
                <span className="flex items-center gap-1.5">
                  <Calendar size={16} />
                  Registered {new Date(node.createdAt).toLocaleDateString()}
                </span>
                {node.region && (
                  <span className="flex items-center gap-1.5">
                    <MapPin size={16} />
                    {node.region}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <Clock size={16} />
                  Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="gradient"
                onClick={handleHeartbeat}
                loading={actionLoading === 'heartbeat'}
                icon={<Heart size={16} />}
              >
                Send Heartbeat
              </Button>

              {node.status === 'ONLINE' && (
                <Button
                  variant="secondary"
                  onClick={() => handleStatusChange('PAUSED')}
                  loading={actionLoading === 'status'}
                  icon={<Pause size={16} />}
                >
                  Pause
                </Button>
              )}

              {node.status === 'PAUSED' && (
                <Button
                  variant="secondary"
                  onClick={() => handleStatusChange('ONLINE')}
                  loading={actionLoading === 'status'}
                  icon={<Play size={16} />}
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
                  icon={<FileText size={16} />}
                >
                  Statement
                </Button>
              </div>

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
          </div>
        </div>
      </motion.div>

      {/* Error Alert */}
      {error && (
        <motion.div variants={itemVariant} className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
            <AlertCircle size={16} className="text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-error/60 hover:text-error">
            <X size={16} />
          </button>
        </motion.div>
      )}

      {/* Stats Grid */}
      <motion.div variants={itemVariant} className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Jobs"
          value={node._count?.jobs || 0}
          variant="blue"
          animate
          icon={<Briefcase size={20} />}
        />
        <StatCard
          label="Completed Jobs"
          value={completedJobs.length}
          variant="accent"
          animate
          icon={<CheckCircle size={20} />}
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
          icon={<Cpu size={20} />}
        />
        <StatCard
          label="Est. Earnings"
          value={totalEarnings.toFixed(2)}
          prefix="$"
          variant="orange"
          animate
          icon={<DollarSign size={20} />}
        />
      </motion.div>

      <motion.div variants={itemVariant} className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Node Info */}
        <Card variant="glass" hover={false}>
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
              <Server size={20} className="text-background" />
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
              <Cpu size={20} className="text-background" />
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
                <Cpu size={32} className="text-text-muted" />
              </div>
              <p className="text-text-muted text-sm">No heartbeat data available</p>
              <p className="text-text-muted text-xs mt-1">Send a heartbeat to see GPU metrics</p>
            </div>
          )}
        </Card>
      </motion.div>

      {/* Heartbeat History */}
      {node.heartbeats && node.heartbeats.length > 0 && (
        <Card variant="glass" hover={false}>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-blue-400 flex items-center justify-center">
                <HeartPulse size={20} className="text-background" />
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
              <Briefcase size={20} className="text-background" />
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
              <Briefcase size={32} className="text-text-muted" />
            </div>
            <p className="text-text-muted text-sm">No jobs processed by this node yet</p>
            <p className="text-text-muted text-xs mt-1">Jobs will appear here once routing begins</p>
          </div>
        )}
      </Card>

      {/* Delete Confirmation Modal */}
      {/* Edit Wallet Address Modal */}
      <Modal
        isOpen={editWalletOpen}
        onClose={() => setEditWalletOpen(false)}
        title="Edit Wallet Address"
        size="md"
      >
        <p className="text-text-muted text-sm mb-4">
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
          <Button
            variant="secondary"
            onClick={() => setEditWalletOpen(false)}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            variant="gradient"
            onClick={handleUpdateWallet}
            loading={actionLoading === 'wallet'}
            className="flex-1"
          >
            Save
          </Button>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
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
    </motion.div>
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

// Icons removed - using lucide-react imports above
