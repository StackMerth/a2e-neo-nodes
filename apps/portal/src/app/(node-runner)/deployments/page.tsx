'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
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

const STATUS_CONFIG: Record<string, { label: string; badge: string; dot: string }> = {
  DEPLOYMENT_REQUESTED: {
    label: 'Requested',
    badge: 'bg-warning/10 text-warning border-warning/20',
    dot: 'bg-warning shadow-[0_0_8px_theme(colors.warning)]',
  },
  DEPLOYING: {
    label: 'Deploying',
    badge: 'bg-info/10 text-info border-info/20',
    dot: 'bg-info shadow-[0_0_8px_theme(colors.info)]',
  },
  PROVISIONED: {
    label: 'Provisioned',
    badge: 'bg-accent/10 text-accent border-accent/20',
    dot: 'bg-accent shadow-[0_0_8px_theme(colors.accent)]',
  },
  CANCELLED: {
    label: 'Cancelled',
    badge: 'bg-surface-hover text-text-muted border-border',
    dot: 'bg-text-muted',
  },
}

const TIER_COLORS: Record<string, string> = {
  H100: 'bg-accent/10 text-accent border-accent/20',
  H200: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
  B200: 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
  B300: 'bg-accent-orange/10 text-accent-orange border-accent-orange/20',
  GB300: 'bg-error/10 text-error border-error/20',
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
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">My Deployments</h1>
          <p className="text-sm text-text-muted mt-1">
            {deployments.length} deployment{deployments.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link href="/deploy">
          <Button>Deploy New Node</Button>
        </Link>
      </div>

      {/* List */}
      {deployments.length === 0 ? (
        <Card className="p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-2">No Deployments Yet</h2>
          <p className="text-text-muted text-sm mb-6">Deploy your first GPU node to start earning.</p>
          <Link href="/deploy">
            <Button>Deploy Your First Node</Button>
          </Link>
        </Card>
      ) : (
        <div className="space-y-4">
          {deployments.map(dep => {
            const status = STATUS_CONFIG[dep.status] ?? STATUS_CONFIG.DEPLOYMENT_REQUESTED
            const tierColor = TIER_COLORS[dep.gpuTier] ?? 'bg-surface-hover text-text-secondary border-border'
            const isActive = dep.status === 'DEPLOYING'

            return (
              <Link key={dep.id} href={`/deployments/${dep.id}`}>
                <div className="bg-surface border border-border rounded-xl p-5 hover:border-accent/30 hover:shadow-card transition-all duration-200">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${tierColor}`}>
                            {dep.gpuTier}
                          </span>
                          <span className="text-text-secondary text-sm">
                            {dep.nodeCount} node{dep.nodeCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2">
                            {isActive ? (
                              <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-info opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-info" />
                              </span>
                            ) : (
                              <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                            )}
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${status.badge}`}>
                              {status.label}
                            </span>
                          </div>
                          <span className="text-xs text-text-muted">
                            {new Date(dep.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-text-primary">
                        ${dep.amount.toLocaleString()}
                      </div>
                      <div className="text-xs text-text-muted">
                        TX: {dep.txHash.slice(0, 8)}...{dep.txHash.slice(-4)}
                      </div>
                    </div>
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
