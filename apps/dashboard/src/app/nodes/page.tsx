'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Server, Wifi, WifiOff, Pause, Wrench, Activity, Plus, Search,
  RefreshCw, X, AlertCircle, CheckCircle, XCircle, AlertTriangle,
  Clock, Heart, Play, Trash2,
} from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { Skeleton, SkeletonStatCard } from '@/components/ui/Skeleton'
import { ConfirmModal } from '@/components/ui/Modal'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const GPU_TIERS = [
  { value: '', label: 'All Tiers' },
  { value: 'H100', label: 'NVIDIA H100' },
  { value: 'H200', label: 'NVIDIA H200' },
  { value: 'B200', label: 'NVIDIA B200' },
  { value: 'B300', label: 'NVIDIA B300' },
  { value: 'GB300', label: 'NVIDIA GB300' },
  // C2 wave 2: consumer / prosumer tiers (inference-only).
  { value: 'RTX_4090', label: 'NVIDIA RTX 4090' },
  { value: 'RTX_3090', label: 'NVIDIA RTX 3090' },
  { value: 'CONSUMER', label: 'Consumer GPU' },
]

const STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'ONLINE', label: 'Online' },
  { value: 'DEGRADED', label: 'Degraded' },
  { value: 'OFFLINE', label: 'Offline' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
]

interface Node {
  id: string
  walletAddress: string
  gpuTier: string
  nodeType: string
  status: string
  region: string | null
  lastHeartbeat: string
  createdAt: string
}

function SkeletonNodesList() {
  return (
    <div className="space-y-3 mt-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="p-4 rounded-xl" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex items-start justify-between">
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-2">
                <Skeleton className="w-3 h-3 rounded-full" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-5 w-12 rounded-md" />
              </div>
              <Skeleton className="h-3 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-8 w-20 rounded-lg" />
              <Skeleton className="h-8 w-16 rounded-lg" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function NodesPage() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [loading, setLoading] = useState(true)
  const [registering, setRegistering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('')
  const [tierFilter, setTierFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const [walletAddress, setWalletAddress] = useState('0x' + Math.random().toString(16).slice(2, 42))
  const [gpuTier, setGpuTier] = useState('H100')
  const [region, setRegion] = useState('')

  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [nodeToDelete, setNodeToDelete] = useState<string | null>(null)

  useEffect(() => {
    loadNodes()
  }, [])

  async function loadNodes() {
    try {
      const data = await api.nodes.list({ limit: 100 })
      setNodes(data.nodes)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load nodes')
    } finally {
      setLoading(false)
    }
  }

  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (statusFilter && node.status !== statusFilter) return false
      if (tierFilter && node.gpuTier !== tierFilter) return false
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        return (
          node.walletAddress.toLowerCase().includes(query) ||
          node.id.toLowerCase().includes(query) ||
          node.gpuTier.toLowerCase().includes(query)
        )
      }
      return true
    })
  }, [nodes, statusFilter, tierFilter, searchQuery])

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {}
    const byTier: Record<string, number> = {}
    nodes.forEach((node) => {
      byStatus[node.status] = (byStatus[node.status] || 0) + 1
      byTier[node.gpuTier] = (byTier[node.gpuTier] || 0) + 1
    })
    return { byStatus, byTier }
  }, [nodes])

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setRegistering(true)
    setError(null)

    try {
      await api.nodes.register({
        walletAddress,
        gpuTier,
        nodeType: 'BYOG',
        region: region || undefined,
      })
      await loadNodes()
      setWalletAddress('0x' + Math.random().toString(16).slice(2, 42))
      setSuccess('Node registered successfully')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register node')
    } finally {
      setRegistering(false)
    }
  }

  async function handleHeartbeat(nodeId: string) {
    setActionLoading(nodeId)
    try {
      await api.nodes.heartbeat(nodeId, {
        gpuUtilization: Math.floor(Math.random() * 80) + 10,
        gpuTemperature: Math.floor(Math.random() * 30) + 50,
      })
      await loadNodes()
      setSuccess('Heartbeat sent')
      setTimeout(() => setSuccess(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Heartbeat failed')
    } finally {
      setActionLoading(null)
    }
  }

  async function handleStatusChange(nodeId: string, newStatus: 'ONLINE' | 'PAUSED' | 'MAINTENANCE') {
    setActionLoading(nodeId)
    try {
      await api.nodes.updateStatus(nodeId, newStatus)
      await loadNodes()
      setSuccess(`Node ${newStatus.toLowerCase()}`)
      setTimeout(() => setSuccess(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status update failed')
    } finally {
      setActionLoading(null)
    }
  }

  function handleDelete(nodeId: string) {
    setNodeToDelete(nodeId)
    setDeleteModalOpen(true)
  }

  async function confirmDelete() {
    if (!nodeToDelete) return

    setActionLoading(nodeToDelete)
    setDeleteModalOpen(false)
    try {
      await api.nodes.delete(nodeToDelete)
      await loadNodes()
      setSuccess('Node deleted')
      setTimeout(() => setSuccess(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setActionLoading(null)
      setNodeToDelete(null)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'accent'
      case 'DEGRADED': return 'orange'
      case 'OFFLINE': return 'gray'
      case 'PAUSED': return 'gray'
      case 'MAINTENANCE': return 'blue'
      default: return 'gray'
    }
  }

  const getStatusDotStyle = (status: string) => {
    switch (status) {
      case 'ONLINE': return { background: 'var(--success)', boxShadow: '0 0 8px var(--success)' }
      case 'DEGRADED': return { background: 'var(--warning)', boxShadow: '0 0 8px var(--warning)' }
      case 'OFFLINE': return { background: 'var(--danger)', boxShadow: '0 0 8px var(--danger)' }
      case 'PAUSED': return { background: 'var(--text-muted)' }
      case 'MAINTENANCE': return { background: 'var(--info)', boxShadow: '0 0 8px var(--info)' }
      default: return { background: 'var(--text-muted)' }
    }
  }

  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'ONLINE': return { background: 'rgba(34,197,94,0.1)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.2)' }
      case 'DEGRADED': return { background: 'rgba(245,158,11,0.1)', color: 'var(--warning)', border: '1px solid rgba(245,158,11,0.2)' }
      case 'OFFLINE': return { background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }
      case 'PAUSED': return { background: 'var(--bg-card-hover)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
      case 'MAINTENANCE': return { background: 'rgba(59,130,246,0.1)', color: 'var(--info)', border: '1px solid rgba(59,130,246,0.2)' }
      default: return { background: 'var(--bg-card-hover)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'ONLINE': return <Wifi size={12} />
      case 'DEGRADED': return <Activity size={12} />
      case 'OFFLINE': return <WifiOff size={12} />
      case 'PAUSED': return <Pause size={12} />
      case 'MAINTENANCE': return <Wrench size={12} />
      default: return <WifiOff size={12} />
    }
  }

  const statusDistribution = Object.entries(stats.byStatus).map(([status, count]) => ({
    label: status,
    value: count,
    color: getStatusColor(status) as 'accent' | 'orange' | 'blue' | 'purple' | 'gray',
  }))

  return (
    <motion.div
      className="space-y-8"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          <Server size={28} style={{ color: 'var(--primary)' }} />
          Nodes
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button onClick={loadNodes} variant="secondary" size="sm" icon={<RefreshCw size={16} />}>Refresh</Button>
          <Link href="/nodes/add"><Button size="sm" icon={<Plus size={16} />}>Add Node</Button></Link>
        </div>
      </motion.div>

      {/* Alerts */}
      {error && (
        <motion.div
          variants={item}
          className="p-4 rounded-xl flex items-center gap-3"
          style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(239,68,68,0.2)' }}>
            <AlertCircle size={16} style={{ color: 'var(--danger)' }} />
          </div>
          <p style={{ color: 'var(--danger)' }} className="text-sm">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto" style={{ color: 'var(--danger)' }}>
            <X size={16} />
          </button>
        </motion.div>
      )}

      {success && (
        <motion.div
          variants={item}
          className="p-4 rounded-xl flex items-center gap-3"
          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(34,197,94,0.2)' }}>
            <CheckCircle size={16} style={{ color: 'var(--success)' }} />
          </div>
          <p style={{ color: 'var(--success)' }} className="text-sm">{success}</p>
        </motion.div>
      )}

      {/* Stats Grid */}
      <motion.div variants={item}>
        {loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonStatCard key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Nodes"
              value={nodes.length}
              variant="accent"
              animate
              icon={<Server size={20} />}
            />
            <StatCard
              label="Online"
              value={stats.byStatus['ONLINE'] ?? 0}
              variant="accent"
              animate
              icon={<Wifi size={20} />}
              trend={nodes.length > 0 ? {
                value: Math.round((stats.byStatus['ONLINE'] ?? 0) / nodes.length * 100),
                isPositive: true
              } : undefined}
            />
            <StatCard
              label="Degraded"
              value={stats.byStatus['DEGRADED'] ?? 0}
              variant="orange"
              animate
              icon={<AlertTriangle size={20} />}
            />
            <StatCard
              label="Offline"
              value={stats.byStatus['OFFLINE'] ?? 0}
              variant="purple"
              animate
              icon={<XCircle size={20} />}
            />
          </div>
        )}
      </motion.div>

      {/* Status Distribution */}
      {!loading && nodes.length > 0 && (
        <motion.div variants={item}>
          <Card variant="glass" hover={false}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Node Status Distribution</h3>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{nodes.length} total nodes</span>
            </div>
            <DistributionBar segments={statusDistribution} size="lg" showLegend />
          </Card>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Add Node Card */}
        <motion.div variants={item}>
          <div className="rounded-xl p-6 h-fit" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                <Plus size={20} style={{ color: 'var(--bg-primary)' }} />
              </div>
              <div>
                <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Add Node</h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Connect a GPU server to the network</p>
              </div>
            </div>

            <Link href="/nodes/add">
              <Button variant="gradient" className="w-full mb-6">
                <Server size={16} className="mr-2" />
                Add Node via SSH
              </Button>
            </Link>

            <div className="pt-4" style={{ borderTop: '1px solid var(--border-color)' }}>
              <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Or register manually (for testing):</p>
            </div>

            <form onSubmit={handleRegister} className="space-y-4">
              <Input
                label="Wallet Address"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                placeholder="0x..."
              />
              <Select
                label="GPU Tier"
                value={gpuTier}
                onChange={(e) => setGpuTier(e.target.value)}
                options={GPU_TIERS.slice(1)}
              />
              <Input
                label="Region (optional)"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-east-1"
              />
              <Button type="submit" loading={registering} variant="gradient" className="w-full">
                Register Node
              </Button>
            </form>
          </div>
        </motion.div>

        {/* Nodes List */}
        <motion.div variants={item} className="lg:col-span-2">
          <div className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-400 flex items-center justify-center">
                  <Server size={20} style={{ color: 'var(--bg-primary)' }} />
                </div>
                <div>
                  <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Registered Nodes</h3>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{filteredNodes.length} of {nodes.length} nodes</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={loadNodes} icon={<RefreshCw size={16} />}>
                Refresh
              </Button>
            </div>

            <div className="flex flex-wrap gap-3 pb-4" style={{ borderBottom: '1px solid var(--border-color)' }}>
              <div className="flex-1 min-w-[200px]">
                <Input
                  placeholder="Search by wallet or ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  icon={<Search size={16} />}
                />
              </div>
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                options={STATUS_OPTIONS}
                className="w-36"
              />
              <Select
                value={tierFilter}
                onChange={(e) => setTierFilter(e.target.value)}
                options={GPU_TIERS}
                className="w-36"
              />
              {(statusFilter || tierFilter || searchQuery) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStatusFilter('')
                    setTierFilter('')
                    setSearchQuery('')
                  }}
                  icon={<X size={16} />}
                >
                  Clear
                </Button>
              )}
            </div>

            {loading ? (
              <SkeletonNodesList />
            ) : filteredNodes.length === 0 ? (
              <div className="py-16 text-center">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: 'var(--bg-card-hover)' }}>
                  <Server size={32} style={{ color: 'var(--text-muted)' }} />
                </div>
                <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  {nodes.length === 0 ? 'No nodes registered' : 'No nodes match your filters'}
                </h3>
                <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                  {nodes.length === 0
                    ? 'Register your first GPU node to get started'
                    : 'Try adjusting your search or filter criteria'}
                </p>
                {nodes.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setStatusFilter('')
                      setTierFilter('')
                      setSearchQuery('')
                    }}
                  >
                    Clear Filters
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3 mt-4">
                {filteredNodes.map((node) => (
                  <div
                    key={node.id}
                    className="p-4 rounded-xl transition-all duration-300 group"
                    style={{
                      background: 'var(--glass-bg)',
                      border: '1px solid var(--glass-border)',
                    }}
                  >
                    {/* The /nodes page lives next to the Add Node form on
                        desktop, leaving the list narrower than a full row.
                        Use xl: (1280px) for the side-by-side layout so on
                        anything narrower the action buttons stack BELOW
                        the info instead of crowding it. Badges + buttons
                        both wrap so they never overlap. */}
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between xl:gap-4">
                      <Link href={`/nodes/${node.id}`} className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <span className="w-3 h-3 rounded-full shrink-0" style={getStatusDotStyle(node.status)} />
                          <span
                            className="px-2.5 py-1 text-xs font-medium rounded-lg inline-flex items-center gap-1 shrink-0"
                            style={getStatusBadgeStyle(node.status)}
                          >
                            {getStatusIcon(node.status)}
                            {node.status}
                          </span>
                          <span
                            className="px-2.5 py-1 text-xs font-medium rounded-lg shrink-0"
                            style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.2)' }}
                          >
                            {node.gpuTier}
                          </span>
                          {node.region && (
                            <span
                              className="px-2.5 py-1 text-xs rounded-lg shrink-0"
                              style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}
                            >
                              {node.region}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-mono truncate transition-colors" style={{ color: 'var(--text-muted)' }}>
                          {node.walletAddress}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                          </span>
                        </div>
                      </Link>

                      <div className="flex flex-wrap items-center gap-1 pt-2 xl:pt-0 border-t xl:border-0 border-border/40 opacity-100 xl:opacity-50 xl:group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.preventDefault(); handleHeartbeat(node.id) }}
                          disabled={actionLoading === node.id}
                          icon={<Heart size={16} />}
                        >
                          {actionLoading === node.id ? '...' : 'Heartbeat'}
                        </Button>

                        {node.status === 'ONLINE' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.preventDefault(); handleStatusChange(node.id, 'PAUSED') }}
                            disabled={actionLoading === node.id}
                            className="text-warning hover:text-warning"
                            icon={<Pause size={16} />}
                          >
                            Pause
                          </Button>
                        )}

                        {node.status === 'PAUSED' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.preventDefault(); handleStatusChange(node.id, 'ONLINE') }}
                            disabled={actionLoading === node.id}
                            className="text-accent hover:text-accent"
                            icon={<Play size={16} />}
                          >
                            Resume
                          </Button>
                        )}

                        {node.status !== 'MAINTENANCE' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.preventDefault(); handleStatusChange(node.id, 'MAINTENANCE') }}
                            disabled={actionLoading === node.id}
                            className="text-accent-blue hover:text-accent-blue"
                            icon={<Wrench size={16} />}
                          >
                            Maint.
                          </Button>
                        )}

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.preventDefault(); handleDelete(node.id) }}
                          disabled={actionLoading === node.id}
                          className="text-error hover:text-error"
                          icon={<Trash2 size={16} />}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => {
          setDeleteModalOpen(false)
          setNodeToDelete(null)
        }}
        onConfirm={confirmDelete}
        title="Delete Node"
        message="Are you sure you want to delete this node? If this is a provisioned node, the agent will be uninstalled on the next heartbeat."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        loading={actionLoading === nodeToDelete}
      />
    </motion.div>
  )
}
