'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface NodeItem {
  id: string
  walletAddress: string
  gpuTier: string
  nodeType: string
  status: string
  region: string | null
  agentVersion: string | null
  currentJobId: string | null
  lastHeartbeat: string
  customGpuModel: string | null
  createdAt: string
}

export default function NodesPage() {
  const [nodes, setNodes] = useState<NodeItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadNodes()
  }, [])

  async function loadNodes() {
    try {
      const data = await nodeRunner.nodes() as { nodes: NodeItem[] }
      setNodes(data.nodes)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const secs = Math.floor(diff / 1000)
    if (secs < 60) return `${secs}s ago`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const statusConfig: Record<string, { label: string; dot: string; badge: string }> = {
    ONLINE: { label: 'Online', dot: 'bg-accent shadow-[0_0_8px_theme(colors.accent)]', badge: 'bg-accent/10 text-accent' },
    OFFLINE: { label: 'Offline', dot: 'bg-error shadow-[0_0_8px_theme(colors.error)]', badge: 'bg-error/10 text-error' },
    DEGRADED: { label: 'Degraded', dot: 'bg-warning shadow-[0_0_8px_theme(colors.warning)]', badge: 'bg-warning/10 text-warning' },
    PAUSED: { label: 'Paused', dot: 'bg-text-muted', badge: 'bg-surface-hover text-text-muted' },
    MAINTENANCE: { label: 'Maintenance', dot: 'bg-info shadow-[0_0_8px_theme(colors.info)]', badge: 'bg-info/10 text-info' },
  }

  const tierColors: Record<string, string> = {
    H100: 'bg-accent/10 text-accent border-accent/20',
    H200: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
    B200: 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
    B300: 'bg-accent-orange/10 text-accent-orange border-accent-orange/20',
    GB300: 'bg-error/10 text-error border-error/20',
    OTHER: 'bg-surface-hover text-text-secondary border-border',
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <div className="flex items-center justify-between"><Skeleton className="h-8 w-40" /><Skeleton className="h-10 w-28" /></div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-48" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Your Nodes</h1>
          <p className="text-sm text-text-muted mt-1">{nodes.length} node{nodes.length !== 1 ? 's' : ''} registered</p>
        </div>
        <Link href="/onboarding"><Button>Add Node</Button></Link>
      </div>

      {nodes.length === 0 ? (
        <Card className="p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" /></svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-2">No Nodes Yet</h2>
          <p className="text-text-muted text-sm mb-6">Get started by installing the A2E agent on your GPU server.</p>
          <Link href="/onboarding"><Button>Set Up Your First Node</Button></Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {nodes.map(node => {
            const status = statusConfig[node.status] ?? statusConfig.OFFLINE!
            const tier = tierColors[node.gpuTier] ?? tierColors.OTHER!
            return (
              <Link key={node.id} href={`/nodes/${node.id}`}>
                <div className="bg-surface border border-border rounded-xl p-5 hover:border-accent/30 hover:shadow-card transition-all duration-200 h-full">
                  <div className="flex items-center justify-between mb-4">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${tier}`}>{node.customGpuModel || node.gpuTier}</span>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                      <span className={`text-xs font-medium ${status.badge} px-2 py-0.5 rounded-full`}>{status.label}</span>
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-text-muted">Wallet</span>
                      <span className="text-text-secondary font-mono text-xs">{node.walletAddress.slice(0, 6)}...{node.walletAddress.slice(-4)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Last Heartbeat</span>
                      <span className="text-text-secondary">{timeAgo(node.lastHeartbeat)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Agent</span>
                      <span className="text-text-secondary">{node.agentVersion ?? 'Unknown'}</span>
                    </div>
                    {node.currentJobId && (
                      <div className="flex items-center gap-2 mt-2 px-2 py-1.5 bg-accent/5 border border-accent/20 rounded-lg">
                        <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-accent" /></span>
                        <span className="text-xs text-accent font-medium">Running job</span>
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
