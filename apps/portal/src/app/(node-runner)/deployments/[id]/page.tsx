'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { Check, Loader2, XCircle, ArrowRight, Info } from 'lucide-react'
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

const TIER_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  H100: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', border: 'rgba(34,197,94,0.2)' },
  H200: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', border: 'rgba(59,130,246,0.2)' },
  B200: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6', border: 'rgba(139,92,246,0.2)' },
  B300: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', border: 'rgba(245,158,11,0.2)' },
  GB300: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: 'rgba(239,68,68,0.2)' },
}

function getStepIndex(status: string): number {
  const idx = STATUS_ORDER.indexOf(status)
  return idx >= 0 ? idx : 1
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function DeploymentDetailPage() {
  const { id } = useParams() as { id: string }
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
      <div className="text-center py-20" style={{ color: 'var(--text-muted)' }}>Deployment not found</div>
    )
  }

  const isCancelled = data.status === 'CANCELLED'
  const currentStepIdx = getStepIndex(data.status)
  const tierStyle = TIER_STYLES[data.gpuTier] ?? { bg: 'var(--bg-card-hover)', color: 'var(--text-secondary)', border: 'var(--border-color)' }

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item}>
        <Link href="/deployments" className="text-sm hover:opacity-80 mb-1 inline-block" style={{ color: 'var(--text-muted)' }}>
          &larr; Back to Deployments
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-3" style={{ color: 'var(--text-primary)' }}>
          {data.gpuTier} Node Deployment
          <span
            className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
            style={{ background: tierStyle.bg, color: tierStyle.color, border: `1px solid ${tierStyle.border}` }}
          >
            {data.gpuTier}
          </span>
        </h1>
      </motion.div>

      {/* Cancelled Banner */}
      {isCancelled && (
        <motion.div variants={item}>
          <div
            className="flex items-center gap-3 p-4 rounded-xl"
            style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}
          >
            <XCircle size={20} className="shrink-0" style={{ color: 'var(--danger)' }} />
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>Deployment Cancelled</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>This deployment has been cancelled and will not proceed.</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* Step Tracker */}
      {!isCancelled && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
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
                        className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300"
                        style={isComplete
                          ? { background: 'var(--primary)', borderColor: 'var(--primary)', border: '2px solid var(--primary)', color: '#fff' }
                          : { background: 'var(--bg-card)', border: '2px solid var(--border-color)', color: 'var(--text-muted)' }
                        }
                      >
                        {isDeploying ? (
                          <Loader2 size={20} className="animate-spin" />
                        ) : isComplete ? (
                          <Check size={20} strokeWidth={2.5} />
                        ) : (
                          <span className="text-sm font-medium">{idx + 1}</span>
                        )}
                      </div>
                      {/* Label */}
                      <span
                        className="text-xs mt-2 text-center font-medium whitespace-nowrap"
                        style={{ color: isComplete ? 'var(--primary)' : 'var(--text-muted)' }}
                      >
                        {step.label}
                      </span>
                    </div>
                    {/* Connecting Line */}
                    {idx < STEPS.length - 1 && (
                      <div className="flex-1 mx-3 mt-[-1.25rem]">
                        <div
                          className="h-0.5 rounded-full transition-all duration-300"
                          style={{ background: idx < currentStepIdx ? 'var(--primary)' : 'var(--border-color)' }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </motion.div>
      )}

      {/* Deploying Animation */}
      {data.status === 'DEPLOYING' && (
        <motion.div variants={item}>
          <div
            className="flex items-center gap-3 p-4 rounded-xl"
            style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.2)' }}
          >
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--info)' }} />
              <span className="relative inline-flex rounded-full h-3 w-3" style={{ background: 'var(--info)' }} />
            </span>
            <p className="text-sm font-medium" style={{ color: 'var(--info)' }}>Your node is being set up. This usually takes a few minutes...</p>
          </div>
        </motion.div>
      )}

      {/* Deployment Info */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <h3 className="text-xs font-medium uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>Deployment Details</h3>
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
        </div>
      </motion.div>

      {/* Provisioned Node Link */}
      {data.status === 'PROVISIONED' && data.nodeId && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6"
            style={{
              background: 'linear-gradient(to right, rgba(34,197,94,0.05), var(--glass-bg))',
              border: '1px solid rgba(34,197,94,0.2)',
            }}
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Node Provisioned</h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Your node is live and earning. View details and monitor performance.</p>
              </div>
              <Link
                href={`/nodes/${data.nodeId}`}
                className="inline-flex items-center gap-2 px-4 py-2.5 font-medium text-sm rounded-lg transition-all duration-200"
                style={{
                  background: 'var(--primary)',
                  color: '#fff',
                  boxShadow: '0 0 10px rgba(34,197,94,0.2)',
                }}
              >
                View Node
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span
        className={`font-medium ${mono ? 'font-mono text-xs break-all' : ''}`}
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </span>
    </div>
  )
}
