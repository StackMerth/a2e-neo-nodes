'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Briefcase, Server, Clock, DollarSign, GitBranch, Shield, Info } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { A2ELoader } from '@/components/ui/A2ELoader'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  EmptyState,
  MetricTriad,
  SectionCard,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

interface JobDetail {
  id: string
  status: string
  market: string | null
  earnings: number | null
  durationSeconds: number | null
  ratePerHour: number | null
  gpuTier: string
  deploymentId: string
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  routingLog: {
    selectedMarket: string
    selectedRate: number
    internalRate: number | null
    akashRate: number | null
    ionetRate: number | null
    yieldFloor: number
    yieldFloorApplied: boolean
    reason: string
  } | null
  node: {
    id: string
    gpuTier: string
    walletAddress: string
  } | null
}

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  COMPLETED: { bg: 'rgba(34,197,94,0.15)', color: 'var(--success)' },
  FAILED: { bg: 'rgba(239,68,68,0.15)', color: 'var(--danger)' },
  RUNNING: { bg: 'rgba(59,130,246,0.15)', color: 'var(--info)' },
  PENDING: { bg: 'rgba(113,113,122,0.15)', color: 'var(--text-muted)' },
  ASSIGNED: { bg: 'rgba(139,92,246,0.15)', color: '#8b5cf6' },
  CANCELLED: { bg: 'rgba(113,113,122,0.15)', color: 'var(--text-muted)' },
  ROUTING: { bg: 'rgba(245,158,11,0.15)', color: 'var(--warning)' },
}

export default function JobDetailPage() {
  const { id } = useParams() as { id: string }
  const [data, setData] = useState<{ job: JobDetail } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const d = await nodeRunner.job(id) as { job: JobDetail }
        setData(d)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
  }, [id])

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading job" />
  }

  if (!data) {
    return (
      <DashboardShell title="Job not found" subtitle="The requested job could not be loaded">
        <div className="lg:col-span-3">
          <SectionCard>
            <EmptyState
              icon={Briefcase}
              title="Job not found"
              description="The job you are looking for could not be loaded."
              action={
                <Link href="/jobs">
                  <button className="text-sm font-medium" style={{ color: 'var(--primary)' }}>Back to Jobs</button>
                </Link>
              }
            />
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  const { job } = data
  const statusStyle = STATUS_STYLES[job.status] ?? STATUS_STYLES.PENDING!

  const formatDuration = (secs: number | null) => {
    if (!secs) return '-'
    const m = Math.floor(secs / 60)
    const s = secs % 60
    if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`
    return `${m}m ${s}s`
  }

  const titleBadge = (
    <span className="text-xs font-medium px-3 py-1 rounded-full" style={{ background: statusStyle.bg, color: statusStyle.color }}>
      {job.status}
    </span>
  )

  const metrics: MetricCardData[] = [
    {
      label: 'Earnings',
      value: job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-',
      detail: job.ratePerHour != null ? `$${job.ratePerHour.toFixed(2)}/hr` : 'Rate unknown',
      icon: DollarSign,
      tone: 'green',
    },
    {
      label: 'Market',
      value: job.market ?? '-',
      detail: 'Routing target',
      icon: GitBranch,
      tone: 'blue',
    },
    {
      label: 'Duration',
      value: formatDuration(job.durationSeconds),
      detail: job.gpuTier,
      icon: Clock,
      tone: 'purple',
    },
  ]

  return (
    <DashboardShell
      title={`Job ${job.id.slice(0, 12)}`}
      subtitle={`Created ${new Date(job.createdAt).toLocaleString()}`}
      liveLabel={job.status === 'RUNNING' ? 'RUNNING' : undefined}
    >
      <DashboardMainColumn>
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] hover:opacity-80 w-fit"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={12} /> Back to Jobs
        </Link>

        <MetricTriad metrics={metrics} />

        <SectionCard title="Job Details" icon={Info} badge={titleBadge}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Row label="Job ID" value={job.id} mono />
            <Row label="Deployment ID" value={job.deploymentId} mono />
            <Row label="Created" value={job.createdAt ? new Date(job.createdAt).toLocaleString() : '-'} />
            <Row label="Started" value={job.startedAt ? new Date(job.startedAt).toLocaleString() : '-'} />
            <Row label="Completed" value={job.completedAt ? new Date(job.completedAt).toLocaleString() : '-'} />
            <Row label="Rate" value={job.ratePerHour != null ? `$${job.ratePerHour.toFixed(2)}/hr` : '-'} />
            {job.errorMessage && <Row label="Error" value={job.errorMessage} error />}
          </div>
        </SectionCard>

        {job.routingLog && (
          <SectionCard title="Routing Decision" icon={Shield}>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{job.routingLog.reason}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Row label="Selected Market" value={job.routingLog.selectedMarket} />
              <Row label="Selected Rate" value={`$${job.routingLog.selectedRate.toFixed(2)}/hr`} />
              <Row label="Internal Rate" value={job.routingLog.internalRate != null ? `$${job.routingLog.internalRate.toFixed(2)}/hr` : 'N/A'} />
              <Row label="Akash Rate" value={job.routingLog.akashRate != null ? `$${job.routingLog.akashRate.toFixed(2)}/hr` : 'N/A'} />
              <Row label="IO.net Rate" value={job.routingLog.ionetRate != null ? `$${job.routingLog.ionetRate.toFixed(2)}/hr` : 'N/A'} />
              <Row label="Yield Floor" value={`$${job.routingLog.yieldFloor.toFixed(2)}/hr`} />
              <Row label="Floor Applied" value={job.routingLog.yieldFloorApplied ? 'Yes' : 'No'} />
            </div>
          </SectionCard>
        )}
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Status" icon={Briefcase}>
          <div className="flex flex-col gap-3">
            <div>
              <span className="text-xs font-medium px-3 py-1.5 rounded-full" style={{ background: statusStyle.bg, color: statusStyle.color }}>
                {job.status}
              </span>
            </div>
            <Row label="GPU Tier" value={job.gpuTier} />
          </div>
        </SectionCard>

        {job.node && (
          <SectionCard title="Assigned Node" icon={Server}>
            <div className="space-y-3 text-sm">
              <Row label="Node ID" value={job.node.id.slice(0, 12)} mono />
              <Row label="GPU Tier" value={job.node.gpuTier} />
              <Row label="Wallet" value={`${job.node.walletAddress.slice(0, 8)}...${job.node.walletAddress.slice(-6)}`} mono />
            </div>
          </SectionCard>
        )}
      </DashboardRightRail>
    </DashboardShell>
  )
}

function Row({ label, value, mono, error }: { label: string; value: string; mono?: boolean; error?: boolean }) {
  return (
    <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: error ? 'var(--danger)' : 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? '0.8rem' : undefined }}>
        {value}
      </span>
    </div>
  )
}
