'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { DistributionBar } from '@/components/ui/ProgressBar'
import { Skeleton, SkeletonStatCard } from '@/components/ui/Skeleton'
import { api } from '@/lib/api'

const GPU_TIERS = [
  { value: '', label: 'All Tiers' },
  { value: 'H100', label: 'NVIDIA H100' },
  { value: 'H200', label: 'NVIDIA H200' },
  { value: 'B200', label: 'NVIDIA B200' },
  { value: 'B300', label: 'NVIDIA B300' },
  { value: 'GB300', label: 'NVIDIA GB300' },
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

// Skeleton components for loading state
function SkeletonNodesList() {
  return (
    <div className="space-y-3 mt-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="p-4 bg-surface/50 rounded-xl border border-border/50">
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

  // Filters
  const [statusFilter, setStatusFilter] = useState('')
  const [tierFilter, setTierFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Register form
  const [walletAddress, setWalletAddress] = useState('0x' + Math.random().toString(16).slice(2, 42))
  const [gpuTier, setGpuTier] = useState('H100')
  const [region, setRegion] = useState('')

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null)

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

  // Filtered nodes
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

  // Stats
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

  async function handleDelete(nodeId: string) {
    if (!confirm('Are you sure you want to delete this node?')) return

    setActionLoading(nodeId)
    try {
      await api.nodes.delete(nodeId)
      await loadNodes()
      setSuccess('Node deleted')
      setTimeout(() => setSuccess(null), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setActionLoading(null)
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

  const getStatusDotColor = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'bg-accent shadow-[0_0_8px_rgba(34,197,94,0.5)]'
      case 'DEGRADED': return 'bg-warning shadow-[0_0_8px_rgba(245,158,11,0.5)]'
      case 'OFFLINE': return 'bg-error shadow-[0_0_8px_rgba(239,68,68,0.5)]'
      case 'PAUSED': return 'bg-text-muted'
      case 'MAINTENANCE': return 'bg-accent-blue shadow-[0_0_8px_rgba(59,130,246,0.5)]'
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

  // Status distribution for DistributionBar
  const statusDistribution = Object.entries(stats.byStatus).map(([status, count]) => ({
    label: status,
    value: count,
    color: getStatusColor(status) as 'accent' | 'orange' | 'blue' | 'purple' | 'gray',
  }))

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Hero Section */}
      <div className="relative py-8 md:py-12">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-accent/5 border border-accent/20 rounded-full mb-6 animate-slideUp">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            <span className="text-xs text-accent font-medium uppercase tracking-wider">Node Registry</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-bold text-text-primary mb-3">
            Node Management
          </h1>
          <p className="text-text-muted max-w-xl mx-auto">
            Register, monitor, and manage GPU nodes across the network.
            Track health metrics and control node status in real-time.
          </p>
        </div>
      </div>

      {/* Alerts */}
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

      {success && (
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-xl flex items-center gap-3 animate-slideUp">
          <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center shrink-0">
            <CheckIcon className="w-4 h-4 text-accent" />
          </div>
          <p className="text-accent text-sm">{success}</p>
        </div>
      )}

      {/* Stats Grid */}
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
            icon={<ServerIcon />}
          />
          <StatCard
            label="Online"
            value={stats.byStatus['ONLINE'] ?? 0}
            variant="accent"
            animate
            icon={<CheckCircleIcon />}
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
            icon={<WarningIcon />}
          />
          <StatCard
            label="Offline"
            value={stats.byStatus['OFFLINE'] ?? 0}
            variant="purple"
            animate
            icon={<XCircleIcon />}
          />
        </div>
      )}

      {/* Status Distribution */}
      {!loading && nodes.length > 0 && (
        <Card variant="glass" hover={false}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-text-primary">Node Status Distribution</h3>
            <span className="text-xs text-text-muted">{nodes.length} total nodes</span>
          </div>
          <DistributionBar segments={statusDistribution} size="lg" showLegend />
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Register Form */}
        <Card variant="glass" hover={false} className="h-fit">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
              <PlusIcon className="w-5 h-5 text-background" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary">Register Node</h3>
              <p className="text-xs text-text-muted">Add a new GPU node to the network</p>
            </div>
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
        </Card>

        {/* Nodes List */}
        <div className="lg:col-span-2">
          <Card variant="glass" hover={false}>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-blue-400 flex items-center justify-center">
                  <ServerStackIcon className="w-5 h-5 text-background" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Registered Nodes</h3>
                  <p className="text-xs text-text-muted">{filteredNodes.length} of {nodes.length} nodes</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={loadNodes} icon={<RefreshIcon />}>
                Refresh
              </Button>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-3 pb-4 border-b border-border/50">
              <div className="flex-1 min-w-[200px]">
                <Input
                  placeholder="Search by wallet or ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  icon={<SearchIcon className="w-4 h-4" />}
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
                  icon={<CloseIcon />}
                >
                  Clear
                </Button>
              )}
            </div>

            {loading ? (
              <SkeletonNodesList />
            ) : filteredNodes.length === 0 ? (
              <div className="py-16 text-center">
                <div className="w-16 h-16 rounded-2xl bg-surface-hover flex items-center justify-center mx-auto mb-4">
                  <ServerIcon className="w-8 h-8 text-text-muted" />
                </div>
                <h3 className="text-sm font-medium text-text-primary mb-1">
                  {nodes.length === 0 ? 'No nodes registered' : 'No nodes match your filters'}
                </h3>
                <p className="text-xs text-text-muted mb-4">
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
                    className={`
                      p-4 rounded-xl border transition-all duration-300
                      bg-surface/50 border-border/50
                      hover:border-accent/30 hover:bg-surface
                      group
                    `}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <Link href={`/nodes/${node.id}`} className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className={`w-3 h-3 rounded-full ${getStatusDotColor(node.status)}`} />
                          <span className={`px-2.5 py-1 text-xs font-medium rounded-lg border ${getStatusBadgeStyle(node.status)}`}>
                            {node.status}
                          </span>
                          <span className="px-2.5 py-1 bg-accent/10 text-accent text-xs font-medium rounded-lg border border-accent/20">
                            {node.gpuTier}
                          </span>
                          {node.region && (
                            <span className="px-2.5 py-1 bg-surface text-text-muted text-xs rounded-lg border border-border">
                              {node.region}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-text-muted font-mono truncate group-hover:text-text-primary transition-colors">
                          {node.walletAddress}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                          <span className="flex items-center gap-1">
                            <ClockIcon className="w-3 h-3" />
                            Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                          </span>
                        </div>
                      </Link>

                      {/* Actions */}
                      <div className="flex items-center gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.preventDefault(); handleHeartbeat(node.id) }}
                          disabled={actionLoading === node.id}
                          icon={<HeartIcon className="w-4 h-4" />}
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
                            icon={<PauseIcon className="w-4 h-4" />}
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
                            icon={<PlayIcon className="w-4 h-4" />}
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
                            icon={<WrenchIcon className="w-4 h-4" />}
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
                          icon={<TrashIcon className="w-4 h-4" />}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

// Icons
function ServerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
    </svg>
  )
}

function ServerStackIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
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

function WarningIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}

function XCircleIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function PlusIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}

function RefreshIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}

function SearchIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
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

function AlertIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function CheckIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
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

function WrenchIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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
