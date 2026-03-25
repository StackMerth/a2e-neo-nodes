'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
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
      case 'ONLINE': return 'bg-accent'
      case 'DEGRADED': return 'bg-warning'
      case 'OFFLINE': return 'bg-error'
      case 'PAUSED': return 'bg-text-muted'
      case 'MAINTENANCE': return 'bg-blue-500'
      default: return 'bg-text-muted'
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Node Management</h1>
        <p className="text-text-muted mt-1">
          Register, monitor, and manage GPU nodes
        </p>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
          <p className="text-accent text-sm">{success}</p>
        </div>
      )}

      {/* Stats Bar */}
      <div className="flex flex-wrap gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded-lg">
          <span className="text-xs text-text-muted">Total:</span>
          <span className="text-sm font-medium text-text-primary">{nodes.length}</span>
        </div>
        {Object.entries(stats.byStatus).map(([status, count]) => (
          <div
            key={status}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded-lg cursor-pointer hover:border-accent/30 transition-colors"
            onClick={() => setStatusFilter(statusFilter === status ? '' : status)}
          >
            <span className={`w-2 h-2 rounded-full ${getStatusColor(status)}`} />
            <span className="text-xs text-text-muted">{status}:</span>
            <span className="text-sm font-medium text-text-primary">{count}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Register Form */}
        <Card title="Register Node" description="Add a new GPU node to the network">
          <form onSubmit={handleRegister} className="space-y-4 mt-4">
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
            <Button type="submit" loading={registering} className="w-full">
              Register Node
            </Button>
          </form>
        </Card>

        {/* Nodes List */}
        <div className="lg:col-span-2">
          <Card
            title="Registered Nodes"
            description={`${filteredNodes.length} of ${nodes.length} nodes`}
            action={
              <Button variant="ghost" size="sm" onClick={loadNodes}>
                Refresh
              </Button>
            }
          >
            {/* Filters */}
            <div className="flex flex-wrap gap-3 mt-4 pb-4 border-b border-border">
              <Input
                placeholder="Search by wallet or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 min-w-[200px]"
              />
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
                >
                  Clear
                </Button>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-text-muted">Loading...</p>
              </div>
            ) : filteredNodes.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-text-muted">
                  {nodes.length === 0 ? 'No nodes registered yet' : 'No nodes match your filters'}
                </p>
              </div>
            ) : (
              <div className="space-y-3 mt-4">
                {filteredNodes.map((node) => (
                  <div
                    key={node.id}
                    className="p-4 bg-background rounded-lg border border-border hover:border-accent/30 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <Link href={`/nodes/${node.id}`} className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`w-2 h-2 rounded-full ${getStatusColor(node.status)}`} />
                          <span className="text-sm font-medium text-text-primary">{node.status}</span>
                          <span className="px-2 py-0.5 bg-accent/10 text-accent text-xs rounded">
                            {node.gpuTier}
                          </span>
                          {node.region && (
                            <span className="px-2 py-0.5 bg-surface text-text-muted text-xs rounded">
                              {node.region}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted font-mono truncate">
                          {node.walletAddress}
                        </p>
                        <p className="text-xs text-text-muted mt-1">
                          Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                        </p>
                      </Link>

                      {/* Actions Dropdown */}
                      <div className="flex items-center gap-1 ml-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.preventDefault(); handleHeartbeat(node.id) }}
                          disabled={actionLoading === node.id}
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
                            className="text-blue-400 hover:text-blue-400"
                          >
                            Maintenance
                          </Button>
                        )}

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.preventDefault(); handleDelete(node.id) }}
                          disabled={actionLoading === node.id}
                          className="text-error hover:text-error"
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
