'use client'

import { useState, useEffect, use, useCallback } from 'react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'

interface DeploymentDetail {
  id: string
  gpuTier: string
  nodeCount: number
  amount: number
  status: string
  txHash: string
  deploymentNote: string | null
  nodeId: string | null
  createdAt: string
  updatedAt: string
}

const STATUS_ORDER = ['PAYMENT_CONFIRMED', 'DEPLOYMENT_REQUESTED', 'DEPLOYING', 'PROVISIONED']

const STEPS = [
  { key: 'PAYMENT_CONFIRMED', label: 'Payment Confirmed' },
  { key: 'DEPLOYMENT_REQUESTED', label: 'Deployment Requested' },
  { key: 'DEPLOYING', label: 'Deploying' },
  { key: 'PROVISIONED', label: 'Node Live' },
]

const TIER_COLORS: Record<string, string> = {
  H100: 'bg-accent/10 text-accent border-accent/20',
  H200: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
  B200: 'bg-accent-purple/10 text-accent-purple border-accent-purple/20',
  B300: 'bg-accent-orange/10 text-accent-orange border-accent-orange/20',
  GB300: 'bg-error/10 text-error border-error/20',
}

function getStepIndex(status: string): number {
  const idx = STATUS_ORDER.indexOf(status)
  return idx >= 0 ? idx : 1
}

export default function DeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { toast } = useToast()
  const [data, setData] = useState<DeploymentDetail | null>(null)
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    try {
      const d = await nodeRunner.deployment(id) as { deployment: DeploymentDetail }
      setData(d.deployment)
    } catch {
      toast('error', 'Failed to load deployment details')
    } finally {
      setLoading(false)
    }
  }, [id, toast])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Auto-refresh while in progress
  useEffect(() => {
    if (!data) return
    const shouldRefresh = data.status === 'DEPLOYMENT_REQUESTED' || data.status === 'DEPLOYING'
    if (!shouldRefresh) return

    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [data, loadData])

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-20 text-text-muted">Deployment not found</div>
    )
  }

  const isCancelled = data.status === 'CANCELLED'
  const currentStepIdx = getStepIndex(data.status)
  const tierColor = TIER_COLORS[data.gpuTier] ?? 'bg-surface-hover text-text-secondary border-border'

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div>
        <Link href="/deployments" className="text-sm text-text-muted hover:text-text-secondary mb-1 inline-block">
          &larr; Back to Deployments
        </Link>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          {data.gpuTier} Node Deployment
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${tierColor}`}>
            {data.gpuTier}
          </span>
        </h1>
      </div>

      {/* Cancelled Banner */}
      {isCancelled && (
        <div className="flex items-center gap-3 p-4 bg-error/5 border border-error/20 rounded-xl">
          <svg className="w-5 h-5 text-error shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <div>
            <p className="text-sm font-medium text-error">Deployment Cancelled</p>
            <p className="text-xs text-text-muted mt-0.5">This deployment has been cancelled and will not proceed.</p>
          </div>
        </div>
      )}

      {/* Step Tracker */}
      {!isCancelled && (
        <Card className="p-6">
          <div className="flex items-center justify-between">
            {STEPS.map((step, idx) => {
              const isComplete = idx <= currentStepIdx
              const isCurrent = idx === currentStepIdx
              const isDeploying = isCurrent && data.status === 'DEPLOYING'

              return (
                <div key={step.key} className="flex items-center flex-1 last:flex-initial">
                  <div className="flex flex-col items-center">
                    {/* Circle */}
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${
                        isComplete
                          ? 'bg-accent border-accent text-white'
                          : 'border-border bg-surface text-text-muted'
                      }`}
                    >
                      {isDeploying ? (
                        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      ) : isComplete ? (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <span className="text-sm font-medium">{idx + 1}</span>
                      )}
                    </div>
                    {/* Label */}
                    <span
                      className={`text-xs mt-2 text-center font-medium whitespace-nowrap ${
                        isComplete ? 'text-accent' : 'text-text-muted'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                  {/* Connecting Line */}
                  {idx < STEPS.length - 1 && (
                    <div className="flex-1 mx-3 mt-[-1.25rem]">
                      <div
                        className={`h-0.5 rounded-full transition-all duration-300 ${
                          idx < currentStepIdx ? 'bg-accent' : 'bg-border'
                        }`}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Deploying Animation */}
      {data.status === 'DEPLOYING' && (
        <div className="flex items-center gap-3 p-4 bg-info/5 border border-info/20 rounded-xl">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-info opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-info" />
          </span>
          <p className="text-sm text-info font-medium">Your node is being set up. This usually takes a few minutes...</p>
        </div>
      )}

      {/* Deployment Info */}
      <Card className="p-6">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">Deployment Details</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <InfoRow label="GPU Tier" value={data.gpuTier} />
          <InfoRow label="Node Count" value={`${data.nodeCount}`} />
          <InfoRow label="Amount" value={`$${data.amount.toLocaleString()}`} />
          <InfoRow label="Date" value={new Date(data.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} />
          <div className="sm:col-span-2">
            <InfoRow
              label="Transaction Hash"
              value={data.txHash}
              mono
            />
          </div>
          {data.deploymentNote && (
            <div className="sm:col-span-2">
              <InfoRow label="Note" value={data.deploymentNote} />
            </div>
          )}
        </div>
      </Card>

      {/* Provisioned Node Link */}
      {data.status === 'PROVISIONED' && data.nodeId && (
        <Card className="p-6 bg-gradient-to-r from-accent/5 via-surface to-surface border-accent/20">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-1">Node Provisioned</h3>
              <p className="text-xs text-text-muted">Your node is live and earning. View details and monitor performance.</p>
            </div>
            <Link
              href={`/nodes/${data.nodeId}`}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white font-medium text-sm rounded-lg transition-all duration-200 shadow-glow-sm hover:shadow-glow-accent"
            >
              View Node
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </Card>
      )}
    </div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text-muted text-xs">{label}</span>
      <span className={`text-text-primary font-medium ${mono ? 'font-mono text-xs break-all' : ''}`}>
        {value}
      </span>
    </div>
  )
}
