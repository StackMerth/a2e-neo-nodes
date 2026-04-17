'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowLeft, Briefcase, Server, Clock, DollarSign, GitBranch, Shield } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-48" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-20" style={{ color: 'var(--text-muted)' }}>
        Job not found
      </div>
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

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item}>
        <Link href="/jobs" className="text-sm inline-flex items-center gap-1 hover:opacity-80" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> Back to Jobs
        </Link>
        <div className="flex items-center justify-between mt-2">
          <h1 className="text-2xl font-bold flex items-center gap-3" style={{ color: 'var(--text-primary)' }}>
            <Briefcase size={28} style={{ color: 'var(--primary)' }} />
            Job: {job.id.slice(0, 12)}
          </h1>
          <span className="text-sm font-medium px-3 py-1.5 rounded-full" style={{ background: statusStyle.bg, color: statusStyle.color }}>
            {job.status}
          </span>
        </div>
      </motion.div>

      {/* KPI Blocks */}
      <motion.div variants={item} className="stat-blocks">
        <div className="stat-block green">
          <div className="stat-icon"><DollarSign size={18} /></div>
          <div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-'}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Earnings</div>
          </div>
        </div>
        <div className="stat-block blue">
          <div className="stat-icon"><GitBranch size={18} /></div>
          <div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{job.market ?? '-'}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Market</div>
          </div>
        </div>
        <div className="stat-block purple">
          <div className="stat-icon"><Clock size={18} /></div>
          <div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{formatDuration(job.durationSeconds)}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Duration</div>
          </div>
        </div>
        <div className="stat-block yellow">
          <div className="stat-icon"><Server size={18} /></div>
          <div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{job.gpuTier}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>GPU Tier</div>
          </div>
        </div>
      </motion.div>

      {/* Job Details */}
      <motion.div variants={item}>
        <div className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Job Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <Row label="Job ID" value={job.id} mono />
            <Row label="Deployment ID" value={job.deploymentId} mono />
            <Row label="Created" value={job.createdAt ? new Date(job.createdAt).toLocaleString() : '-'} />
            <Row label="Started" value={job.startedAt ? new Date(job.startedAt).toLocaleString() : '-'} />
            <Row label="Completed" value={job.completedAt ? new Date(job.completedAt).toLocaleString() : '-'} />
            <Row label="Rate" value={job.ratePerHour != null ? `$${job.ratePerHour.toFixed(2)}/hr` : '-'} />
            {job.errorMessage && <Row label="Error" value={job.errorMessage} error />}
          </div>
        </div>
      </motion.div>

      {/* Routing Decision */}
      {job.routingLog && (
        <motion.div variants={item}>
          <div className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <div className="flex items-center gap-2 mb-4">
              <Shield size={16} style={{ color: 'var(--text-secondary)' }} />
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Routing Decision</h2>
            </div>
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
          </div>
        </motion.div>
      )}

      {/* Node Info */}
      {job.node && (
        <motion.div variants={item}>
          <div className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Assigned Node</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <Row label="Node ID" value={job.node.id.slice(0, 12)} mono />
              <Row label="GPU Tier" value={job.node.gpuTier} />
              <Row label="Wallet" value={`${job.node.walletAddress.slice(0, 8)}...${job.node.walletAddress.slice(-6)}`} mono />
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}

function Row({ label, value, mono, error }: { label: string; value: string; mono?: boolean; error?: boolean }) {
  return (
    <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: error ? 'var(--danger)' : 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? '0.8rem' : undefined }}>{value}</span>
    </div>
  )
}
