'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Package, Rocket } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface Deployment {
  id: string
  gpuTier: string
  nodeCount: number
  amount: number
  status: string
  txHash: string
  deploymentNote: string | null
  nodeId: string | null
  createdAt: string
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; border: string; dotColor: string; dotGlow: string }> = {
  DEPLOYMENT_REQUESTED: {
    label: 'Requested',
    bg: 'rgba(245,158,11,0.1)',
    color: 'var(--warning)',
    border: 'rgba(245,158,11,0.2)',
    dotColor: 'var(--warning)',
    dotGlow: '0 0 8px var(--warning)',
  },
  DEPLOYING: {
    label: 'Deploying',
    bg: 'rgba(59,130,246,0.1)',
    color: 'var(--info)',
    border: 'rgba(59,130,246,0.2)',
    dotColor: 'var(--info)',
    dotGlow: '0 0 8px var(--info)',
  },
  PROVISIONED: {
    label: 'Provisioned',
    bg: 'rgba(34,197,94,0.1)',
    color: 'var(--success)',
    border: 'rgba(34,197,94,0.2)',
    dotColor: 'var(--success)',
    dotGlow: '0 0 8px var(--success)',
  },
  CANCELLED: {
    label: 'Cancelled',
    bg: 'var(--bg-card-hover)',
    color: 'var(--text-muted)',
    border: 'var(--border-color)',
    dotColor: 'var(--text-muted)',
    dotGlow: 'none',
  },
}

const TIER_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  H100: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', border: 'rgba(34,197,94,0.2)' },
  H200: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', border: 'rgba(59,130,246,0.2)' },
  B200: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6', border: 'rgba(139,92,246,0.2)' },
  B300: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', border: 'rgba(245,158,11,0.2)' },
  GB300: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: 'rgba(239,68,68,0.2)' },
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemAnim = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDeployments()
  }, [])

  async function loadDeployments() {
    try {
      const data = await nodeRunner.deployments() as { deployments: Deployment[] }
      setDeployments(data.deployments)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-36" />
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-36" />)}
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
      {/* Header */}
      <motion.div variants={itemAnim} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>My Deployments</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {deployments.length} deployment{deployments.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link href="/deploy">
          <Button><Rocket size={16} className="mr-2" />Deploy New Node</Button>
        </Link>
      </motion.div>

      {/* List */}
      {deployments.length === 0 ? (
        <motion.div variants={itemAnim}>
          <div
            className="rounded-xl p-12 text-center"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(34,197,94,0.1)' }}
            >
              <Package size={32} style={{ color: 'var(--primary)' }} />
            </div>
            <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>No Deployments Yet</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>Deploy your first GPU node to start earning.</p>
            <Link href="/deploy">
              <Button>Deploy Your First Node</Button>
            </Link>
          </div>
        </motion.div>
      ) : (
        <div className="space-y-4">
          {deployments.map(dep => {
            const status = STATUS_CONFIG[dep.status] ?? STATUS_CONFIG.DEPLOYMENT_REQUESTED!
            const tierStyle = TIER_STYLES[dep.gpuTier] ?? { bg: 'var(--bg-card-hover)', color: 'var(--text-secondary)', border: 'var(--border-color)' }
            const isActive = dep.status === 'DEPLOYING'

            return (
              <motion.div key={dep.id} variants={itemAnim}>
                <Link href={`/deployments/${dep.id}`}>
                  <div
                    className="rounded-xl p-5 transition-all duration-200 hover-lift"
                    style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-3">
                            <span
                              className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
                              style={{ background: tierStyle.bg, color: tierStyle.color, border: `1px solid ${tierStyle.border}` }}
                            >
                              {dep.gpuTier}
                            </span>
                            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                              {dep.nodeCount} node{dep.nodeCount !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              {isActive ? (
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--info)' }} />
                                  <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: 'var(--info)' }} />
                                </span>
                              ) : (
                                <span
                                  className="w-2 h-2 rounded-full"
                                  style={{ background: status.dotColor, boxShadow: status.dotGlow }}
                                />
                              )}
                              <span
                                className="text-xs font-medium px-2 py-0.5 rounded-full"
                                style={{ background: status.bg, color: status.color, border: `1px solid ${status.border}` }}
                              >
                                {status.label}
                              </span>
                            </div>
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              {new Date(dep.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                          ${dep.amount.toLocaleString()}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          TX: {dep.txHash.slice(0, 8)}...{dep.txHash.slice(-4)}
                        </div>
                      </div>
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
