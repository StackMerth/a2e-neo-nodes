'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Check,
  Loader2,
  XCircle,
  ArrowRight,
  ArrowLeft,
  Package,
  Info,
  Rocket,
  Terminal,
  Copy,
} from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { A2ELoader } from '@/components/ui/A2ELoader'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  EmptyState,
  SectionCard,
} from '@/components/dashboard/FuturisticShell'

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

export default function DeploymentDetailPage() {
  const { id } = useParams() as { id: string }
  const { toast } = useToast()
  const [data, setData] = useState<DeploymentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [installCommand, setInstallCommand] = useState<string | null>(null)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const d = await nodeRunner.deployment(id) as { deployment: DeploymentDetail; installCommand: string | null }
      setData(d.deployment)
      setInstallCommand(d.installCommand ?? null)
    } catch {
      toast('error', 'Failed to load deployment details')
    } finally {
      setLoading(false)
      setRefreshing(false)
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

    const interval = setInterval(() => loadData(), 10000)
    return () => clearInterval(interval)
  }, [data, loadData])

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading deployment" />
  }

  if (!data) {
    return (
      <DashboardShell title="Deployment not found" subtitle="The requested deployment could not be loaded">
        <div className="lg:col-span-3">
          <SectionCard>
            <EmptyState
              icon={Package}
              title="Deployment not found"
              description="The deployment you are looking for could not be loaded."
              action={
                <Link href="/deployments">
                  <button className="text-sm font-medium" style={{ color: 'var(--primary)' }}>Back to Deployments</button>
                </Link>
              }
            />
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  const isCancelled = data.status === 'CANCELLED'
  const currentStepIdx = getStepIndex(data.status)
  const tierStyle = TIER_STYLES[data.gpuTier] ?? { bg: 'var(--bg-card-hover)', color: 'var(--text-secondary)', border: 'var(--border-color)' }

  const titleBadge = (
    <span
      className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: tierStyle.bg, color: tierStyle.color, border: `1px solid ${tierStyle.border}` }}
    >
      {data.gpuTier}
    </span>
  )

  return (
    <DashboardShell
      title={`${data.gpuTier} Node Deployment`}
      subtitle={new Date(data.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
      liveLabel={data.status === 'DEPLOYING' ? 'DEPLOYING' : undefined}
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <Link
          href="/deployments"
          className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] hover:opacity-80 w-fit"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={12} /> Back to Deployments
        </Link>

        {isCancelled ? (
          <SectionCard>
            <div className="flex items-center gap-3">
              <XCircle size={20} className="shrink-0" style={{ color: 'var(--danger)' }} />
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>Deployment Cancelled</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>This deployment has been cancelled and will not proceed.</p>
              </div>
            </div>
          </SectionCard>
        ) : (
          <SectionCard title="Deployment Progress" icon={Rocket} badge={titleBadge}>
            <div className="flex items-center justify-between">
              {STEPS.map((step, idx) => {
                const isComplete = idx <= currentStepIdx
                const isCurrent = idx === currentStepIdx
                const isDeploying = isCurrent && data.status === 'DEPLOYING'

                return (
                  <div key={step.key} className="flex items-center flex-1 last:flex-initial">
                    <div className="flex flex-col items-center">
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center transition-all duration-300"
                        style={isComplete
                          ? { background: 'var(--primary)', borderColor: 'var(--primary)', border: '2px solid var(--primary)', color: '#fff' }
                          : { background: 'var(--bg-elevated)', border: '2px solid var(--border-color)', color: 'var(--text-muted)' }
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
                      <span
                        className="text-xs mt-2 text-center font-medium whitespace-nowrap"
                        style={{ color: isComplete ? 'var(--primary)' : 'var(--text-muted)' }}
                      >
                        {step.label}
                      </span>
                    </div>
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
          </SectionCard>
        )}

        {/* Self-serve install path. Surface the curl one-liner the
            moment a deployment lands so the operator can install
            the agent on their GPU machine without waiting for an
            admin to mint a token. The card stays visible while the
            install is pending; once the node is provisioned, the
            install command is irrelevant and the progress card
            advances. */}
        {installCommand && data.status === 'DEPLOYMENT_REQUESTED' && (
          <SectionCard title="Install on your machine" icon={Terminal}>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              Run this one-line command on the Linux box with the GPU you&rsquo;re
              attaching. The installer self-detects hardware, registers the
              node with this deployment, and starts the agent.
            </p>
            <div
              className="rounded-md p-3 font-mono text-xs flex items-start gap-2 break-all"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            >
              <code className="flex-1">{installCommand}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(installCommand)
                  toast('success', 'Install command copied')
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold shrink-0 hover:opacity-90 transition-opacity"
                style={{ background: 'var(--primary)', color: '#fff' }}
              >
                <Copy size={12} />
                Copy
              </button>
            </div>
            <ul className="mt-3 text-xs space-y-1.5" style={{ color: 'var(--text-muted)' }}>
              <li>• Requires root (the installer uses <code>sudo</code> for systemd + Docker setup).</li>
              <li>• Token is one-shot. After install completes, this page advances to <strong>Deploying</strong>.</li>
              <li>• Stuck? Check your machine has Docker + nvidia-docker installed and the GPU is visible to <code>nvidia-smi</code>.</li>
            </ul>
          </SectionCard>
        )}

        {data.status === 'DEPLOYING' && (
          <SectionCard>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: 'var(--info)' }} />
                <span className="relative inline-flex rounded-full h-3 w-3" style={{ background: 'var(--info)' }} />
              </span>
              <p className="text-sm font-medium" style={{ color: 'var(--info)' }}>
                Your node is being set up. This usually takes a few minutes...
              </p>
            </div>
          </SectionCard>
        )}

        {data.status === 'PROVISIONED' && data.nodeId && (
          <SectionCard>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Node Provisioned</h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Your node is live and earning. View details and monitor performance.</p>
              </div>
              <Link
                href={`/nodes/${data.nodeId}`}
                className="inline-flex items-center gap-2 px-4 py-2.5 font-medium text-sm rounded-md transition-all duration-200"
                style={{
                  background: 'var(--primary)',
                  color: '#fff',
                }}
              >
                View Node
                <ArrowRight size={16} />
              </Link>
            </div>
          </SectionCard>
        )}
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Deployment Details" icon={Info}>
          <div className="space-y-4 text-sm">
            <InfoRow label="GPU Tier" value={data.gpuTier} />
            <InfoRow label="Node Count" value={`${data.nodeCount}`} />
            <InfoRow label="Amount" value={`$${data.amount.toLocaleString()}`} />
            <InfoRow label="Date" value={new Date(data.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} />
            <InfoRow label="Transaction Hash" value={data.txHash} mono />
            {data.deploymentNote && <InfoRow label="Note" value={data.deploymentNote} />}
          </div>
        </SectionCard>
      </DashboardRightRail>
    </DashboardShell>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span
        className={`font-medium ${mono ? 'font-mono text-xs break-all' : ''}`}
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </span>
    </div>
  )
}
