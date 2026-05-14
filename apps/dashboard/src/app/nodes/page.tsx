'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import {
  Server, Wifi, WifiOff, Pause, Wrench, Activity, Plus, Search,
  X, AlertCircle, CheckCircle,
  Clock, Heart, Play, Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { ConfirmModal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import {
  DashboardShell,
  SectionCard,
  EmptyState,
} from '@/components/dashboard/FuturisticShell'

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

  const filterBar = (
    <div className="flex gap-2 flex-wrap items-center">
      <div className="flex-1 min-w-[180px]">
        <Input
          placeholder="Search by wallet or ID..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          icon={<Search size={14} />}
        />
      </div>
      <Select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        options={STATUS_OPTIONS}
        className="w-32"
      />
      <Select
        value={tierFilter}
        onChange={(e) => setTierFilter(e.target.value)}
        options={GPU_TIERS}
        className="w-32"
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
          icon={<X size={14} />}
        >
          Clear
        </Button>
      )}
      <Link href="/nodes/add">
        <Button size="sm" icon={<Plus size={14} />}>Add Node</Button>
      </Link>
    </div>
  )

  return (
    <DashboardShell
      title="Nodes"
      subtitle={`${nodes.length} node${nodes.length !== 1 ? 's' : ''} registered`}
      onRefresh={loadNodes}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        {error && (
          <div
            className="p-4 rounded-md flex items-center gap-3"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}
          >
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(239,68,68,0.2)' }}>
              <AlertCircle size={16} style={{ color: 'var(--danger)' }} />
            </div>
            <p style={{ color: 'var(--danger)' }} className="text-sm">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto" style={{ color: 'var(--danger)' }}>
              <X size={16} />
            </button>
          </div>
        )}

        {success && (
          <div
            className="p-4 rounded-md flex items-center gap-3"
            style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}
          >
            <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(34,197,94,0.2)' }}>
              <CheckCircle size={16} style={{ color: 'var(--success)' }} />
            </div>
            <p style={{ color: 'var(--success)' }} className="text-sm">{success}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <SectionCard title="Register Node" icon={Plus}>
              <Link href="/nodes/add" className="block mb-5">
                <Button variant="gradient" className="w-full">
                  <Server size={14} className="mr-2" />
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
            </SectionCard>
          </div>

          <div className="lg:col-span-2">
            <SectionCard
              title="Registered Nodes"
              icon={Server}
              actions={filterBar}
            >
              {loading ? (
                <p className="font-mono text-xs text-center py-10" style={{ color: 'var(--text-muted)' }}>
                  Loading...
                </p>
              ) : filteredNodes.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title={nodes.length === 0 ? 'No nodes registered' : 'No nodes match your filters'}
                  description={
                    nodes.length === 0
                      ? 'Register your first GPU node to get started'
                      : 'Try adjusting your search or filter criteria'
                  }
                  action={
                    nodes.length > 0 ? (
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
                    ) : undefined
                  }
                />
              ) : (
                <div className="space-y-3">
                  {filteredNodes.map((node) => (
                    <div
                      key={node.id}
                      className="p-4 rounded-md transition-all duration-300 group"
                      style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <Link href={`/nodes/${node.id}`} className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-2 flex-wrap">
                            <span className="w-3 h-3 rounded-full" style={getStatusDotStyle(node.status)} />
                            <span
                              className="px-2.5 py-1 text-xs font-medium rounded-md inline-flex items-center gap-1"
                              style={getStatusBadgeStyle(node.status)}
                            >
                              {getStatusIcon(node.status)}
                              {node.status}
                            </span>
                            <span
                              className="px-2.5 py-1 text-xs font-medium rounded-md"
                              style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.2)' }}
                            >
                              {node.gpuTier}
                            </span>
                            {node.region && (
                              <span
                                className="px-2.5 py-1 text-xs rounded-md"
                                style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}
                              >
                                {node.region}
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                            {node.walletAddress}
                          </p>
                          <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                            <span className="flex items-center gap-1">
                              <Clock size={12} />
                              Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                            </span>
                          </div>
                        </Link>

                        <div className="flex items-center gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.preventDefault(); handleHeartbeat(node.id) }}
                            disabled={actionLoading === node.id}
                            icon={<Heart size={14} />}
                          >
                            {actionLoading === node.id ? '...' : 'Heartbeat'}
                          </Button>

                          {node.status === 'ONLINE' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => { e.preventDefault(); handleStatusChange(node.id, 'PAUSED') }}
                              disabled={actionLoading === node.id}
                              icon={<Pause size={14} />}
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
                              icon={<Play size={14} />}
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
                              icon={<Wrench size={14} />}
                            >
                              Maint.
                            </Button>
                          )}

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.preventDefault(); handleDelete(node.id) }}
                            disabled={actionLoading === node.id}
                            icon={<Trash2 size={14} />}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </div>
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
    </DashboardShell>
  )
}
