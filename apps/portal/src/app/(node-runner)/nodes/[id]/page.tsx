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
  Zap,
  Sparkles,
  DollarSign,
  RotateCcw,
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
  // C4 wave 1: benchmark fields. All nullable until the first run
  // completes; UI handles "never benchmarked" cleanly.
  benchmarkScore: number | null
  benchmarkMatmulTflops: number | null
  benchmarkVramBandwidthGbs: number | null
  lastBenchmarkAt: string | null
  // C2 wave 2: operator-declared residential-IP marker. Drives the
  // "Home GPU" badge on the marketplace listing for this node.
  isResidential: boolean
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

  // C2 wave 2: flip the residential flag for this node. Optimistic
  // toast on success keeps the toggle responsive; reload pulls the
  // authoritative value back so the UI never drifts from server state.
  async function handleResidentialChange(isResidential: boolean) {
    setActionLoading(true)
    try {
      await nodeRunner.updateNode(id, { isResidential })
      toast('success', isResidential ? 'Marked as home GPU' : 'Cleared home GPU flag')
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

        {/* C2 wave 2: residential / home-GPU self-declaration. Honest
            signal to buyers that this host may be on a home internet
            connection (no static IP, behind NAT, possibly lower SLA).
            Toggle persists immediately so the marketplace badge flips
            on the next public-listings revalidation tick. */}
        <SectionCard title="Connection" icon={HardDrive}>
          <div className="flex items-start gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={node.isResidential}
              disabled={actionLoading}
              onClick={() => handleResidentialChange(!node.isResidential)}
              className="relative inline-flex h-5 w-9 shrink-0 mt-0.5 rounded-full transition-colors disabled:opacity-50"
              style={{
                background: node.isResidential ? 'var(--primary)' : 'var(--bg-elevated)',
                border: '1px solid var(--border-color)',
              }}
            >
              <span
                className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
                style={{
                  transform: node.isResidential ? 'translateX(16px)' : 'translateX(2px)',
                  marginTop: '1px',
                }}
              />
            </button>
            <div className="flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Home / residential connection
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Surfaces a &ldquo;Home GPU&rdquo; badge on the marketplace so buyers know this is on a home connection (no static IP, possibly lower SLA).
              </p>
            </div>
          </div>
        </SectionCard>

        {/* #7 operator-set pricing: per-node Pricing card. Operators
            choose a rate within a ±25% band around the YieldFloor for
            their tier. Hidden / inert for OTHER tier (no YieldFloor
            anchor — operators set customRatePerHour instead). */}
        <PricingCard nodeId={node.id} gpuTier={node.gpuTier} />

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

        {/* C4 wave 1: benchmark card. Shows last score + matmul/bandwidth
            metrics if benchmarked; "Run Benchmark" button otherwise (and
            re-run button after cool-down). Polls every 10s while waiting
            for an agent callback after triggering. */}
        <BenchmarkCard nodeId={node.id} node={node} onRefresh={() => loadData(true)} />
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

/**
 * C4 wave 1: Benchmark card on the node detail page.
 *
 * Three display states:
 *   1. Never benchmarked — empty state with prominent "Run Benchmark" CTA
 *   2. Benchmarked — score + matmul TFLOPS + bandwidth GB/s + "ran X days ago"
 *      with "Re-run benchmark" button
 *   3. Queued (just clicked) — spinner + status text; polls parent's
 *      loadData every 10s until lastBenchmarkAt changes
 *
 * 5-minute cool-down between runs is enforced server-side; we
 * disable the button client-side too for snappier UX.
 */
function BenchmarkCard({
  nodeId,
  node,
  onRefresh,
}: {
  nodeId: string
  node: NodeDetail
  onRefresh: () => void
}) {
  const { toast } = useToast()
  const [triggering, setTriggering] = useState(false)
  // Track the lastBenchmarkAt we saw when triggering, so we can detect
  // when the agent has reported back (lastBenchmarkAt has advanced).
  const [awaitingResult, setAwaitingResult] = useState(false)
  const [waitStartedAt, setWaitStartedAt] = useState<string | null>(null)

  // Poll parent every 10s while waiting for an agent callback. Stops
  // as soon as lastBenchmarkAt advances past what we recorded at
  // trigger time, OR after 5 min hard timeout.
  useEffect(() => {
    if (!awaitingResult) return
    const interval = setInterval(() => {
      onRefresh()
      if (
        node.lastBenchmarkAt &&
        waitStartedAt &&
        new Date(node.lastBenchmarkAt) > new Date(waitStartedAt)
      ) {
        setAwaitingResult(false)
        toast('success', 'Benchmark complete')
      }
    }, 10_000)
    const timeout = setTimeout(() => {
      setAwaitingResult(false)
      toast('error', 'Benchmark timed out (>5 min). Check the agent is online.')
    }, 5 * 60 * 1000)
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [awaitingResult, node.lastBenchmarkAt, waitStartedAt, onRefresh, toast])

  // Client-side cool-down check; server enforces too but mirroring here
  // disables the button immediately on result so users don't bash it.
  const cooldownMs = 5 * 60 * 1000
  const cooldownRemaining =
    node.lastBenchmarkAt && Date.now() - new Date(node.lastBenchmarkAt).getTime() < cooldownMs
      ? Math.ceil((cooldownMs - (Date.now() - new Date(node.lastBenchmarkAt).getTime())) / 1000)
      : 0

  async function handleRun() {
    setTriggering(true)
    try {
      const r = await nodeRunner.runBenchmark(nodeId)
      toast('success', r.message)
      // Snapshot the current lastBenchmarkAt so the poll loop can
      // detect "agent reported back" vs "no change yet".
      setWaitStartedAt(node.lastBenchmarkAt ?? new Date(0).toISOString())
      setAwaitingResult(true)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to queue benchmark')
    } finally {
      setTriggering(false)
    }
  }

  const hasScore = node.benchmarkScore != null
  const lastRunAgoDays = node.lastBenchmarkAt
    ? Math.floor((Date.now() - new Date(node.lastBenchmarkAt).getTime()) / 86_400_000)
    : null

  return (
    <SectionCard title="Benchmark" icon={Gauge}>
      {hasScore ? (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Score</span>
            <div className="text-right">
              <span className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--primary)' }}>
                {node.benchmarkScore!.toFixed(0)}
              </span>
              <span className="text-sm ml-1" style={{ color: 'var(--text-muted)' }}>/ 100</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div
              className="rounded-md p-2"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
            >
              <p className="font-mono uppercase tracking-[0.16em] mb-1" style={{ color: 'var(--text-muted)' }}>
                Matmul
              </p>
              <p className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>
                {node.benchmarkMatmulTflops != null ? `${node.benchmarkMatmulTflops.toFixed(0)} TFLOPS` : '—'}
              </p>
            </div>
            <div
              className="rounded-md p-2"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
            >
              <p className="font-mono uppercase tracking-[0.16em] mb-1" style={{ color: 'var(--text-muted)' }}>
                Bandwidth
              </p>
              <p className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>
                {node.benchmarkVramBandwidthGbs != null ? `${node.benchmarkVramBandwidthGbs.toFixed(0)} GB/s` : '—'}
              </p>
            </div>
          </div>

          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Last run {lastRunAgoDays === 0 ? 'today' : lastRunAgoDays === 1 ? 'yesterday' : `${lastRunAgoDays}d ago`}
          </p>

          <Button
            size="sm"
            variant="secondary"
            onClick={handleRun}
            disabled={triggering || awaitingResult || cooldownRemaining > 0}
            loading={triggering || awaitingResult}
            className="w-full"
          >
            <Zap size={14} className="mr-2" />
            {awaitingResult
              ? 'Running…'
              : cooldownRemaining > 0
                ? `Re-run available in ${Math.ceil(cooldownRemaining / 60)}m`
                : 'Re-run benchmark'}
          </Button>
        </div>
      ) : (
        <div className="text-center py-2">
          <Sparkles size={24} style={{ color: 'var(--text-muted)', margin: '0 auto 8px' }} />
          <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
            Run a one-click benchmark to verify your node&rsquo;s real performance.
          </p>
          <Button
            size="sm"
            onClick={handleRun}
            disabled={triggering || awaitingResult}
            loading={triggering || awaitingResult}
            className="w-full"
          >
            <Zap size={14} className="mr-2" />
            {awaitingResult ? 'Running…' : 'Run benchmark'}
          </Button>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Takes 2-5 min (first run pulls a Docker image).
          </p>
        </div>
      )}
    </SectionCard>
  )
}

/**
 * #7 operator-set pricing card.
 *
 * Loads the effective rate + allowed band for the node, lets the
 * operator type a $/hour value inside that band, and writes it
 * back. The band is YieldFloor ± 25% by default (tunable server-side
 * via OPERATOR_RATE_FLOOR_PCT / OPERATOR_RATE_CEILING_PCT).
 *
 * OTHER-tier nodes have no YieldFloor anchor — they use
 * customRatePerHour on the node directly, so we render an explainer
 * instead of the editor.
 */
function PricingCard({ nodeId, gpuTier }: { nodeId: string; gpuTier: string }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<{
    effective: { ratePerHour: number; ratePerDay: number; source: 'operator' | 'custom' | 'floor' | 'none' }
    band: {
      minPerHour: number; minPerDay: number
      maxPerHour: number; maxPerDay: number
      floorPerHour: number; floorPerDay: number
    } | null
    operatorRatePerHour: number | null
    operatorRateUpdatedAt: string | null
  } | null>(null)
  const [input, setInput] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await nodeRunner.getNodeRate(nodeId)
      setData(r)
      setInput((r.operatorRatePerHour ?? r.effective.ratePerHour).toFixed(2))
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load pricing')
    } finally {
      setLoading(false)
    }
  }, [nodeId, toast])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    const value = parseFloat(input)
    if (!Number.isFinite(value) || value <= 0) {
      toast('error', 'Enter a valid rate per hour')
      return
    }
    setSaving(true)
    try {
      await nodeRunner.setNodeRate(nodeId, value)
      toast('success', 'Pricing updated')
      await load()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    setSaving(true)
    try {
      await nodeRunner.setNodeRate(nodeId, null)
      toast('success', 'Reverted to market baseline')
      await load()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to reset')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <SectionCard title="Pricing" icon={DollarSign}>
        <div className="flex items-center justify-center py-6">
          <Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
        </div>
      </SectionCard>
    )
  }

  if (!data) return null

  // OTHER tier: no YieldFloor band exists, so operator-set pricing
  // doesn't apply. Surface the alternate path (customRatePerHour) so
  // the operator isn't left wondering why the input is missing.
  if (gpuTier === 'OTHER' || !data.band) {
    return (
      <SectionCard title="Pricing" icon={DollarSign}>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          This tier sets rates directly. Current rate:{' '}
          <span className="font-mono font-medium" style={{ color: 'var(--text-primary)' }}>
            ${data.effective.ratePerHour.toFixed(2)}/hr
          </span>
        </p>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          Operator-set bands are available for named GPU tiers only.
        </p>
      </SectionCard>
    )
  }

  const { effective, band, operatorRatePerHour, operatorRateUpdatedAt } = data
  const sourceLabel: Record<typeof effective.source, string> = {
    operator: 'Operator-set',
    custom: 'Custom',
    floor: 'Market baseline',
    none: 'Unset',
  }
  const sourceStyle: Record<typeof effective.source, { color: string; bg: string }> = {
    operator: { color: 'var(--primary)', bg: 'rgba(34,197,94,0.12)' },
    custom: { color: 'var(--info)', bg: 'rgba(59,130,246,0.12)' },
    floor: { color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
    none: { color: 'var(--warning)', bg: 'rgba(245,158,11,0.12)' },
  }

  const parsedInput = parseFloat(input)
  const inputValid = Number.isFinite(parsedInput) && parsedInput >= band.minPerHour && parsedInput <= band.maxPerHour
  const inputChanged = Number.isFinite(parsedInput) && Math.abs(parsedInput - effective.ratePerHour) > 0.001

  // Position of the effective rate on the band track (0-100%) for the
  // mini-slider visualization. Clamp because operator rates set before
  // a band change could fall slightly outside; we still want a sane dot.
  const bandWidth = band.maxPerHour - band.minPerHour
  const ratePos = bandWidth > 0
    ? Math.min(100, Math.max(0, ((effective.ratePerHour - band.minPerHour) / bandWidth) * 100))
    : 50
  const baselinePos = bandWidth > 0
    ? ((band.floorPerHour - band.minPerHour) / bandWidth) * 100
    : 50
  // Preview position for the in-progress input value, only shown while typing
  // a valid in-band number that differs from the saved rate.
  const previewPos = inputValid && inputChanged && bandWidth > 0
    ? Math.min(100, Math.max(0, ((parsedInput - band.minPerHour) / bandWidth) * 100))
    : null

  return (
    <SectionCard title="Pricing" icon={DollarSign}>
      <div className="space-y-5">
        {/* Hero: effective rate + source pill */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-muted)' }}>
              Effective rate
            </p>
            <p className="font-display font-bold tracking-tight tabular-nums mt-1.5 leading-none" style={{ color: 'var(--text-primary)', fontSize: '2.5rem' }}>
              ${effective.ratePerHour.toFixed(2)}
              <span className="font-sans font-normal ml-1.5" style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>/hr</span>
            </p>
            <p className="text-xs mt-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>
              ≈ ${effective.ratePerDay.toFixed(2)} / day
            </p>
          </div>
          <span
            className="font-mono text-[10px] uppercase tracking-[0.16em] px-2.5 py-1 rounded-full font-semibold whitespace-nowrap"
            style={{ background: sourceStyle[effective.source].bg, color: sourceStyle[effective.source].color }}
          >
            {sourceLabel[effective.source]}
          </span>
        </div>

        {/* Mini-slider band */}
        <div>
          <div className="relative h-2 rounded-full" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
            {/* baseline tick */}
            <div
              className="absolute w-0.5 h-3 -top-0.5"
              style={{ left: `${baselinePos}%`, background: 'var(--text-muted)', opacity: 0.5, transform: 'translateX(-50%)' }}
              title="Market baseline"
            />
            {/* preview ghost dot while typing */}
            {previewPos !== null && (
              <div
                className="absolute w-3 h-3 rounded-full -top-0.5 transition-all"
                style={{
                  left: `${previewPos}%`,
                  background: 'transparent',
                  border: '2px dashed var(--primary)',
                  transform: 'translateX(-50%)',
                }}
              />
            )}
            {/* saved-rate dot */}
            <div
              className="absolute w-3.5 h-3.5 rounded-full -top-1 shadow-md transition-all"
              style={{
                left: `${ratePos}%`,
                background: sourceStyle[effective.source].color,
                transform: 'translateX(-50%)',
                boxShadow: `0 0 0 3px ${sourceStyle[effective.source].bg}`,
              }}
            />
          </div>
          <div className="flex justify-between mt-2.5 font-mono text-[11px]">
            <span style={{ color: 'var(--text-muted)' }}>${band.minPerHour.toFixed(2)} min</span>
            <span style={{ color: 'var(--primary)' }} className="font-semibold">${band.floorPerHour.toFixed(2)} baseline</span>
            <span style={{ color: 'var(--text-muted)' }}>${band.maxPerHour.toFixed(2)} max</span>
          </div>
        </div>

        {/* Input */}
        <div>
          <label className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2 block" style={{ color: 'var(--text-muted)' }}>
            Your rate
          </label>
          <div className="relative">
            <span
              className="absolute left-3.5 top-1/2 -translate-y-1/2 font-display font-bold pointer-events-none"
              style={{ color: 'var(--text-muted)', fontSize: '1.25rem' }}
            >
              $
            </span>
            <input
              type="number"
              step="0.01"
              min={band.minPerHour}
              max={band.maxPerHour}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={saving}
              className="w-full rounded-lg pl-9 pr-14 py-3 font-display font-bold tabular-nums outline-none transition-all focus:ring-2"
              style={{
                background: 'var(--bg-elevated)',
                border: `1.5px solid ${inputValid || !input ? 'var(--border-color)' : 'var(--danger)'}`,
                color: 'var(--text-primary)',
                fontSize: '1.5rem',
              }}
            />
            <span
              className="absolute right-3.5 top-1/2 -translate-y-1/2 font-mono text-sm pointer-events-none"
              style={{ color: 'var(--text-muted)' }}
            >
              /hr
            </span>
          </div>
          {input && !inputValid && (
            <p className="text-xs mt-2 font-medium" style={{ color: 'var(--danger)' }}>
              Must be between ${band.minPerHour.toFixed(2)} and ${band.maxPerHour.toFixed(2)}
            </p>
          )}
          {inputValid && inputChanged && (
            <p className="text-xs mt-2 font-mono" style={{ color: 'var(--text-muted)' }}>
              ≈ ${(parsedInput * 24).toFixed(2)} per day
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !inputValid || !inputChanged}
            loading={saving}
            className="flex-1"
          >
            Save rate
          </Button>
          {operatorRatePerHour != null && (
            <Button
              size="sm"
              variant="secondary"
              onClick={handleReset}
              disabled={saving}
              title="Revert to market baseline"
            >
              <RotateCcw size={14} />
            </Button>
          )}
        </div>

        {operatorRateUpdatedAt && (
          <p className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
            Last changed {new Date(operatorRateUpdatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </SectionCard>
  )
}
