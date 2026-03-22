'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'

const GPU_TIERS = [
  { value: 'H100', label: 'NVIDIA H100' },
  { value: 'H200', label: 'NVIDIA H200' },
  { value: 'B200', label: 'NVIDIA B200' },
  { value: 'B300', label: 'NVIDIA B300' },
  { value: 'GB300', label: 'NVIDIA GB300' },
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

  // Register form
  const [walletAddress, setWalletAddress] = useState('0x' + Math.random().toString(16).slice(2, 42))
  const [gpuTier, setGpuTier] = useState('H100')
  const [region, setRegion] = useState('')

  useEffect(() => {
    loadNodes()
  }, [])

  async function loadNodes() {
    try {
      const data = await api.nodes.list({ limit: 50 })
      setNodes(data.nodes)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load nodes')
    } finally {
      setLoading(false)
    }
  }

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
      // Reset form
      setWalletAddress('0x' + Math.random().toString(16).slice(2, 42))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register node')
    } finally {
      setRegistering(false)
    }
  }

  async function handleHeartbeat(nodeId: string) {
    try {
      await api.nodes.heartbeat(nodeId, {
        gpuUtilization: Math.floor(Math.random() * 80) + 10,
        gpuTemperature: Math.floor(Math.random() * 30) + 50,
      })
      await loadNodes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Heartbeat failed')
    }
  }

  async function handleDelete(nodeId: string) {
    if (!confirm('Are you sure you want to delete this node?')) return

    try {
      await api.nodes.delete(nodeId)
      await loadNodes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
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
              options={GPU_TIERS}
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
          <Card title="Registered Nodes" description={`${nodes.length} nodes in the network`}>
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-text-muted">Loading...</p>
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <p className="text-text-muted">No nodes registered yet</p>
              </div>
            ) : (
              <div className="space-y-3 mt-4">
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    className="p-4 bg-background rounded-lg border border-border"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`w-2 h-2 rounded-full ${getStatusColor(node.status)}`} />
                          <span className="text-sm font-medium text-text-primary">{node.status}</span>
                          <span className="px-2 py-0.5 bg-accent/10 text-accent text-xs rounded">
                            {node.gpuTier}
                          </span>
                        </div>
                        <p className="text-xs text-text-muted font-mono truncate">
                          {node.walletAddress}
                        </p>
                        <p className="text-xs text-text-muted mt-1">
                          Last heartbeat: {new Date(node.lastHeartbeat).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleHeartbeat(node.id)}
                        >
                          Heartbeat
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(node.id)}
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
