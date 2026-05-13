'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Server, Wifi, WifiOff, Pause, Wrench, Activity, Globe } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { getMarketColor } from '@/lib/market-colors'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface ExternalDeploymentSummary {
  id: string
  market: string
  status: string
  ratePerHour: number
}

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
  isInUse?: boolean
  assignedComputeRequestId?: string | null
  externalDeployments?: ExternalDeploymentSummary[]
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
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

  const statusConfig: Record<string, { label: string; icon: React.ReactNode; dotColor: string; badgeBg: string; badgeText: string }> = {
    ONLINE: {
      label: 'Online',
      icon: <Wifi size={12} />,
      dotColor: 'var(--success)',
      badgeBg: 'rgba(34,197,94,0.1)',
      badgeText: 'var(--success)',
    },
    OFFLINE: {
      label: 'Offline',
      icon: <WifiOff size={12} />,
      dotColor: 'var(--danger)',
      badgeBg: 'rgba(239,68,68,0.1)',
      badgeText: 'var(--danger)',
    },
    DEGRADED: {
      label: 'Degraded',
      icon: <Activity size={12} />,
      dotColor: 'var(--warning)',
      badgeBg: 'rgba(245,158,11,0.1)',
      badgeText: 'var(--warning)',
    },
    PAUSED: {
      label: 'Paused',
      icon: <Pause size={12} />,
      dotColor: 'var(--text-muted)',
      badgeBg: 'var(--bg-card-hover)',
      badgeText: 'var(--text-muted)',
    },
    MAINTENANCE: {
      label: 'Maintenance',
      icon: <Wrench size={12} />,
      dotColor: 'var(--info)',
      badgeBg: 'rgba(59,130,246,0.1)',
      badgeText: 'var(--info)',
    },
  }

  const tierColors: Record<string, { bg: string; text: string; border: string }> = {
    H100: { bg: 'rgba(34,197,94,0.1)', text: 'var(--success)', border: 'rgba(34,197,94,0.2)' },
    H200: { bg: 'rgba(59,130,246,0.1)', text: 'var(--info)', border: 'rgba(59,130,246,0.2)' },
    B200: { bg: 'rgba(139,92,246,0.1)', text: '#8b5cf6', border: 'rgba(139,92,246,0.2)' },
    B300: { bg: 'rgba(245,158,11,0.1)', text: 'var(--warning)', border: 'rgba(245,158,11,0.2)' },
    GB300: { bg: 'rgba(239,68,68,0.1)', text: 'var(--danger)', border: 'rgba(239,68,68,0.2)' },
    OTHER: { bg: 'var(--bg-card-hover)', text: 'var(--text-secondary)', border: 'var(--border-color)' },
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
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Your Nodes</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{nodes.length} node{nodes.length !== 1 ? 's' : ''} registered</p>
        </div>
        <Link href="/onboarding"><Button>Add Node</Button></Link>
      </motion.div>

      {nodes.length === 0 ? (
        <motion.div variants={item}>
          <Card className="p-12 text-center" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(34,197,94,0.1)' }}
            >
              <Server size={32} style={{ color: 'var(--primary)' }} />
            </div>
            <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>No Nodes Yet</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>Get started by installing the TokenOS DeAI agent on your GPU server.</p>
            <Link href="/onboarding"><Button>Set Up Your First Node</Button></Link>
          </Card>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {nodes.map((node, idx) => {
            const status = statusConfig[node.status] ?? statusConfig.OFFLINE!
            const tier = tierColors[node.gpuTier] ?? tierColors.OTHER!
            const activeExternal = node.externalDeployments?.[0]
            return (
              <motion.div key={node.id} variants={item}>
                <Link href={`/nodes/${node.id}`}>
                  <div
                    className="rounded-xl p-5 transition-all duration-200 h-full hover-lift"
                    style={{
                      background: 'var(--glass-bg)',
                      backdropFilter: 'blur(var(--glass-blur, 24px))',
                      WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
                      border: '1px solid var(--glass-border)',
                      boxShadow: 'var(--glass-shadow, 0 4px 16px rgba(0, 0, 0, 0.3))',
                    }}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <span
                        className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
                        style={{ background: tier.bg, color: tier.text, border: `1px solid ${tier.border}` }}
                      >
                        {node.customGpuModel || node.gpuTier}
                      </span>
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: status.dotColor, boxShadow: `0 0 8px ${status.dotColor}` }}
                        />
                        <span
                          className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                          style={{ background: status.badgeBg, color: status.badgeText }}
                        >
                          {status.icon}
                          {status.label}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--text-secondary)' }}>Wallet</span>
                        <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{node.walletAddress.slice(0, 6)}...{node.walletAddress.slice(-4)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--text-secondary)' }}>Last Heartbeat</span>
                        <span style={{ color: 'var(--text-primary)' }}>{timeAgo(node.lastHeartbeat)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--text-secondary)' }}>Agent</span>
                        <span style={{ color: 'var(--text-primary)' }}>{node.agentVersion ?? 'Unknown'}</span>
                      </div>
                      {/* Usage + External listing badges */}
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {(node.isInUse || node.assignedComputeRequestId) ? (
                          <span
                            className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                            style={{ background: 'rgba(59,130,246,0.1)', color: 'var(--info)' }}
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ background: 'var(--info)', boxShadow: '0 0 6px var(--info)' }}
                            />
                            In Use
                          </span>
                        ) : (
                          <span
                            className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                            style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ background: 'var(--text-muted)' }}
                            />
                            Idle
                          </span>
                        )}
                        {activeExternal && (() => {
                          const mc = getMarketColor(activeExternal.market)
                          return (
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                              style={{ background: mc.bg, color: mc.text }}
                              title={`Listed externally on ${mc.label} (${activeExternal.status})`}
                            >
                              <Globe size={10} />
                              External: {mc.label}
                            </span>
                          )
                        })()}
                      </div>
                      {node.currentJobId && (
                        <div
                          className="flex items-center gap-2 mt-2 px-2 py-1.5 rounded-lg"
                          style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}
                        >
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--primary)' }} />
                            <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: 'var(--primary)' }} />
                          </span>
                          <span className="text-xs font-medium" style={{ color: 'var(--primary)' }}>Running job</span>
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              </motion.div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}
