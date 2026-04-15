'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Cpu, Thermometer, MemoryStick, Clock, MapPin, Tag, Server, Activity, CircleCheck, CircleX, Loader2, Ban } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'

interface NodeDetail {
  id: string; walletAddress: string; gpuTier: string; nodeType: string; status: string
  region: string | null; agentVersion: string | null; currentJobId: string | null
  lastHeartbeat: string; customGpuModel: string | null; customRatePerHour: number | null; createdAt: string
  heartbeats: Array<{ id: string; gpuUtilization: number | null; gpuTemperature: number | null; gpuMemoryUsed: number | null; gpuMemoryTotal: number | null; timestamp: string }>
  jobs: Array<{ id: string; status: string; market: string | null; earnings: number | null; durationSeconds: number | null; createdAt: string; completedAt: string | null }>
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function NodeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<{ node: NodeDetail; uptimeEarnings: { earnings: number; uptimeHours: number } } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => { loadData() }, [id])

  async function loadData() {
    try {
      const d = await nodeRunner.node(id) as { node: NodeDetail; uptimeEarnings: { earnings: number; uptimeHours: number } }
      setData(d)
    } catch { toast('error', 'Failed to load node') }
    finally { setLoading(false) }
  }

  async function handleStatusChange(status: string) {
    setActionLoading(true)
    try {
      await nodeRunner.updateNode(id, { status })
      toast('success', `Node ${status.toLowerCase()}`)
      await loadData()
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed') }
    finally { setActionLoading(false) }
  }

  async function handleDelete() {
    setActionLoading(true)
    try {
      await nodeRunner.deleteNode(id)
      toast('success', 'Node marked for removal')
      router.push('/nodes')
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed') }
    finally { setActionLoading(false); setShowDeleteModal(false) }
  }

  if (loading) return <div className="space-y-4 animate-fadeIn">{[1,2,3].map(i => <Skeleton key={i} className="h-40" />)}</div>
  if (!data) return <div className="text-center py-20" style={{ color: 'var(--text-muted)' }}>Node not found</div>

  const { node, uptimeEarnings } = data
  const lastHb = node.heartbeats[0]

  const statusStyles: Record<string, { bg: string; color: string }> = {
    ONLINE: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' },
    OFFLINE: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)' },
    DEGRADED: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)' },
    PAUSED: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' },
    MAINTENANCE: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' },
  }

  const statusStyle = statusStyles[node.status] ?? { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <Link href="/nodes" className="text-sm hover:opacity-80 mb-1 inline-block" style={{ color: 'var(--text-muted)' }}>&larr; Back to Nodes</Link>
          <h1 className="text-2xl font-bold flex items-center gap-3" style={{ color: 'var(--text-primary)' }}>
            {node.customGpuModel || node.gpuTier} Node
            <span
              className="text-xs px-2.5 py-1 rounded-full font-medium"
              style={{ background: statusStyle.bg, color: statusStyle.color }}
            >
              {node.status}
            </span>
          </h1>
        </div>
        <div className="flex gap-2">
          {node.status === 'ONLINE' && <Button variant="secondary" size="sm" onClick={() => handleStatusChange('PAUSED')} loading={actionLoading}>Pause</Button>}
          {node.status === 'PAUSED' && <Button size="sm" onClick={() => handleStatusChange('ONLINE')} loading={actionLoading}>Resume</Button>}
          {node.status !== 'MAINTENANCE' && <Button variant="secondary" size="sm" onClick={() => handleStatusChange('MAINTENANCE')} loading={actionLoading}>Maintenance</Button>}
          <Button variant="danger" size="sm" onClick={() => setShowDeleteModal(true)}>Remove</Button>
        </div>
      </motion.div>

      {/* Specs + Earnings */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <motion.div variants={item}>
          <div
            className="rounded-xl p-5 h-full"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <h3 className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Specifications</h3>
            <div className="space-y-2 text-sm">
              <SpecRow icon={<Cpu size={14} />} label="GPU Tier" value={node.gpuTier} />
              <SpecRow icon={<Server size={14} />} label="Type" value={node.nodeType} />
              <SpecRow icon={<MapPin size={14} />} label="Region" value={node.region ?? 'Unknown'} />
              <SpecRow icon={<Tag size={14} />} label="Agent" value={node.agentVersion ?? 'Unknown'} />
              <SpecRow icon={<Clock size={14} />} label="Registered" value={new Date(node.createdAt).toLocaleDateString()} />
            </div>
          </div>
        </motion.div>
        <motion.div variants={item}>
          <div
            className="rounded-xl p-5 h-full"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <h3 className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>Performance (30d)</h3>
            <div className="space-y-2 text-sm">
              <Row label="Uptime" value={`${uptimeEarnings.uptimeHours.toFixed(1)} hrs`} />
              <Row label="Earnings" value={`$${uptimeEarnings.earnings.toFixed(2)}`} />
              <Row label="Last Heartbeat" value={node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleTimeString() : 'Never'} />
            </div>
          </div>
        </motion.div>
        <motion.div variants={item}>
          <div
            className="rounded-xl p-5 h-full"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <h3 className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>GPU Metrics</h3>
            {lastHb ? (
              <div className="space-y-2 text-sm">
                <SpecRow icon={<Thermometer size={14} />} label="Temperature" value={lastHb.gpuTemperature != null ? `${lastHb.gpuTemperature}\u00b0C` : 'N/A'} />
                <SpecRow icon={<Activity size={14} />} label="GPU Util" value={lastHb.gpuUtilization != null ? `${lastHb.gpuUtilization}%` : 'N/A'} />
                <SpecRow icon={<MemoryStick size={14} />} label="Memory" value={lastHb.gpuMemoryUsed != null && lastHb.gpuMemoryTotal != null ? `${(lastHb.gpuMemoryUsed / 1024).toFixed(1)} / ${(lastHb.gpuMemoryTotal / 1024).toFixed(1)} GB` : 'N/A'} />
              </div>
            ) : <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No metrics available</p>}
          </div>
        </motion.div>
      </div>

      {/* Recent Jobs */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Recent Jobs</h3>
          {node.jobs.length === 0 ? (
            <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>No jobs executed yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
                    <th className="text-left py-2 font-medium">Job ID</th><th className="text-left py-2 font-medium">Status</th>
                    <th className="text-left py-2 font-medium">Market</th><th className="text-right py-2 font-medium">Earnings</th>
                    <th className="text-right py-2 font-medium">Duration</th><th className="text-right py-2 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {node.jobs.map(job => (
                    <tr key={job.id} className="transition-colors" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                      <td className="py-2.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{job.id.slice(0, 8)}</td>
                      <td className="py-2.5"><JobBadge status={job.status} /></td>
                      <td className="py-2.5" style={{ color: 'var(--text-secondary)' }}>{job.market ?? '-'}</td>
                      <td className="py-2.5 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-'}</td>
                      <td className="py-2.5 text-right" style={{ color: 'var(--text-secondary)' }}>{job.durationSeconds != null ? `${Math.floor(job.durationSeconds / 60)}m ${job.durationSeconds % 60}s` : '-'}</td>
                      <td className="py-2.5 text-right text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(job.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </motion.div>

      {/* Delete Modal */}
      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Remove Node">
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>Are you sure you want to remove this node? The agent will be uninstalled on the next heartbeat.</p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} loading={actionLoading}>Remove Node</Button>
        </div>
      </Modal>
    </motion.div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

function SpecRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
        {icon}
        {label}
      </span>
      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

function JobBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
    COMPLETED: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', icon: <CircleCheck size={12} /> },
    FAILED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: <CircleX size={12} /> },
    RUNNING: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', icon: <Loader2 size={12} className="animate-spin" /> },
    PENDING: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)', icon: <Clock size={12} /> },
    CANCELLED: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)', icon: <Ban size={12} /> },
  }
  const c = config[status] ?? config.PENDING!
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
      style={{ background: c.bg, color: c.color }}
    >
      {c.icon}
      {status}
    </span>
  )
}
