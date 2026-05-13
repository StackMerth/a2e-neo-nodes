'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, useParams } from 'next/navigation'
import {
  Cpu,
  Thermometer,
  MemoryStick,
  Clock,
  MapPin,
  Tag,
  Server,
  Activity,
  CircleCheck,
  CircleX,
  Loader2,
  Ban,
  ArrowLeft,
  Briefcase,
  HardDrive,
  Gauge,
} from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { A2ELoader } from '@/components/ui/A2ELoader'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  DataTableCard,
  EmptyState,
  SectionCard,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface NodeJob {
  id: string
  status: string
  market: string | null
  earnings: number | null
  durationSeconds: number | null
  createdAt: string
  completedAt: string | null
}

interface NodeHeartbeat {
  id: string
  gpuUtilization: number | null
  gpuTemperature: number | null
  gpuMemoryUsed: number | null
  gpuMemoryTotal: number | null
  timestamp: string
}

interface NodeDetail {
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
  customRatePerHour: number | null
  createdAt: string
  heartbeats: NodeHeartbeat[]
  jobs: NodeJob[]
}

type JobRow = NodeJob & Record<string, unknown>

export default function NodeDetailPage() {
  const { id } = useParams() as { id: string }
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<{ node: NodeDetail; uptimeEarnings: { earnings: number; uptimeHours: number } } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const d = await nodeRunner.node(id) as { node: NodeDetail; uptimeEarnings: { earnings: number; uptimeHours: number } }
      setData(d)
    } catch { toast('error', 'Failed to load node') }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [id, toast])

  useEffect(() => { loadData() }, [loadData])

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

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading node" />
  }

  if (!data) {
    return (
      <DashboardShell title="Node not found" subtitle="The requested node could not be loaded">
        <div className="lg:col-span-3">
          <SectionCard>
            <EmptyState
              icon={Server}
              title="Node not found"
              description="The node you are looking for could not be loaded."
              action={
                <Link href="/nodes">
                  <Button variant="secondary">Back to Nodes</Button>
                </Link>
              }
            />
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

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

  const jobColumns: Array<DataTableColumn<JobRow>> = [
    {
      key: 'id',
      header: 'Job ID',
      mono: true,
      render: (j) => (
        <Link href={`/jobs/${j.id}`} className="hover:underline" style={{ color: 'var(--primary)' }}>
          {j.id.slice(0, 8)}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (j) => <JobBadge status={j.status} />,
    },
    {
      key: 'market',
      header: 'Market',
      render: (j) => j.market ?? '-',
    },
    {
      key: 'earnings',
      header: 'Earnings',
      align: 'right',
      mono: true,
      render: (j) => j.earnings != null ? `$${j.earnings.toFixed(4)}` : '-',
    },
    {
      key: 'durationSeconds',
      header: 'Duration',
      align: 'right',
      mono: true,
      render: (j) => j.durationSeconds != null ? `${Math.floor(j.durationSeconds / 60)}m ${j.durationSeconds % 60}s` : '-',
    },
    {
      key: 'createdAt',
      header: 'Date',
      align: 'right',
      mono: true,
      render: (j) => new Date(j.createdAt).toLocaleDateString(),
    },
  ]

  const titleBadge = (
    <span
      className="text-xs px-2.5 py-1 rounded-full font-medium"
      style={{ background: statusStyle.bg, color: statusStyle.color }}
    >
      {node.status}
    </span>
  )

  return (
    <DashboardShell
      title={`${node.customGpuModel || node.gpuTier} Node`}
      subtitle={`Registered ${new Date(node.createdAt).toLocaleDateString()}`}
      liveLabel={node.status === 'ONLINE' ? 'LIVE' : undefined}
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <Link
          href="/nodes"
          className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] hover:opacity-80 w-fit"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={12} /> Back to Nodes
        </Link>

        <SectionCard title="Performance (30d)" icon={Gauge} badge={titleBadge}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Stat label="Uptime" value={`${uptimeEarnings.uptimeHours.toFixed(1)} hrs`} />
            <Stat label="Earnings" value={`$${uptimeEarnings.earnings.toFixed(2)}`} />
            <Stat label="Last Heartbeat" value={node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleTimeString() : 'Never'} />
          </div>
        </SectionCard>

        <DataTableCard<JobRow>
          title="Recent Jobs"
          icon={Briefcase}
          columns={jobColumns}
          rows={(node.jobs ?? []) as JobRow[]}
          empty={
            <EmptyState
              icon={Briefcase}
              title="No jobs yet"
              description="Jobs executed on this node will appear here."
            />
          }
        />
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard
          title="Controls"
          icon={Activity}
        >
          <div className="flex flex-col gap-2">
            {node.status === 'ONLINE' && (
              <Button variant="secondary" size="sm" onClick={() => handleStatusChange('PAUSED')} loading={actionLoading}>Pause</Button>
            )}
            {node.status === 'PAUSED' && (
              <Button size="sm" onClick={() => handleStatusChange('ONLINE')} loading={actionLoading}>Resume</Button>
            )}
            {node.status !== 'MAINTENANCE' && (
              <Button variant="secondary" size="sm" onClick={() => handleStatusChange('MAINTENANCE')} loading={actionLoading}>Maintenance</Button>
            )}
            <Button variant="danger" size="sm" onClick={() => setShowDeleteModal(true)}>Remove</Button>
          </div>
        </SectionCard>

        <SectionCard title="Specifications" icon={Server}>
          <div className="space-y-3 text-sm">
            <SpecRow icon={<Cpu size={14} />} label="GPU Tier" value={node.gpuTier} />
            <SpecRow icon={<HardDrive size={14} />} label="Type" value={node.nodeType} />
            <SpecRow icon={<MapPin size={14} />} label="Region" value={node.region ?? 'Unknown'} />
            <SpecRow icon={<Tag size={14} />} label="Agent" value={node.agentVersion ?? 'Unknown'} />
            <SpecRow icon={<Clock size={14} />} label="Registered" value={new Date(node.createdAt).toLocaleDateString()} />
          </div>
        </SectionCard>

        <SectionCard title="GPU Metrics" icon={Activity}>
          {lastHb ? (
            <div className="space-y-3 text-sm">
              <SpecRow icon={<Thermometer size={14} />} label="Temperature" value={lastHb.gpuTemperature != null ? `${lastHb.gpuTemperature}°C` : 'N/A'} />
              <SpecRow icon={<Activity size={14} />} label="GPU Util" value={lastHb.gpuUtilization != null ? `${lastHb.gpuUtilization}%` : 'N/A'} />
              <SpecRow icon={<MemoryStick size={14} />} label="Memory" value={lastHb.gpuMemoryUsed != null && lastHb.gpuMemoryTotal != null ? `${(lastHb.gpuMemoryUsed / 1024).toFixed(1)} / ${(lastHb.gpuMemoryTotal / 1024).toFixed(1)} GB` : 'N/A'} />
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No metrics available</p>
          )}
        </SectionCard>
      </DashboardRightRail>

      {/* Delete Modal */}
      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Remove Node">
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
          Are you sure you want to remove this node? The agent will be uninstalled on the next heartbeat.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} loading={actionLoading}>Remove Node</Button>
        </div>
      </Modal>
    </DashboardShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md p-3" style={{ background: 'var(--bg-elevated)' }}>
      <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className="font-display text-xl tracking-tight mt-1" style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
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
