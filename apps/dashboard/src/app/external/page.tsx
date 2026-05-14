'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Globe,
  AlertTriangle,
  Clock,
  ArrowUp,
  ArrowDown,
  Save,
  MoreVertical,
  CheckCircle2,
  XCircle,
  Activity,
  DollarSign,
  Beaker,
  Settings as SettingsIcon,
  Server,
} from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

type ExternalMarket = 'AKASH' | 'IONET' | 'VASTAI'
type DeploymentStatus = 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'

const MARKETS: ReadonlyArray<ExternalMarket> = ['AKASH', 'IONET', 'VASTAI']
const GPU_TIERS = ['H100', 'H200', 'B200']

const STATUS_FILTERS: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: 'All', value: 'PENDING,ACTIVE,TERMINATING,TERMINATED,FAILED' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Terminating', value: 'TERMINATING' },
]

const MARKET_COLORS: Record<ExternalMarket, string> = {
  AKASH: '#ef4444',
  IONET: '#8b5cf6',
  VASTAI: '#22c55e',
}

const MARKET_LABELS: Record<ExternalMarket, string> = {
  AKASH: 'Akash',
  IONET: 'IO.net',
  VASTAI: 'Vast.ai',
}

interface OverflowConfigForm {
  enabled: boolean
  simulationMode: boolean
  idleThresholdMinutes: number
  demandThresholdPercent: number
  marginProtectionPercent: number
  gracePeriodSeconds: number
  preferredMarkets: ExternalMarket[]
}

type StatusResponse = Awaited<ReturnType<typeof api.external.status>>
type DeploymentsResponse = Awaited<ReturnType<typeof api.external.deployments>>
type EarningsResponse = Awaited<ReturnType<typeof api.external.earnings>>

function timeAgo(date: string | null | undefined): string {
  if (!date) return '-'
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return '-'
  const diffMs = Date.now() - d.getTime()
  const abs = Math.abs(diffMs)
  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  const day = Math.round(hr / 24)
  const suffix = diffMs >= 0 ? 'ago' : 'from now'
  if (sec < 60) return `${sec}s ${suffix}`
  if (min < 60) return `${min} min ${suffix}`
  if (hr < 24) return `${hr}h ${suffix}`
  return `${day}d ${suffix}`
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`
}

export default function ExternalMarketsPage() {
  const { addToast } = useToast()

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [deployments, setDeployments] = useState<DeploymentsResponse | null>(null)
  const [earnings, setEarnings] = useState<EarningsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [config, setConfig] = useState<OverflowConfigForm | null>(null)
  const [configDirty, setConfigDirty] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)

  const [statusFilter, setStatusFilter] = useState<string | undefined>(STATUS_FILTERS[0].value)
  const [actionMenuFor, setActionMenuFor] = useState<string | null>(null)
  const [delistTarget, setDelistTarget] = useState<{
    nodeId: string
    deploymentId: string
    mode: 'safe' | 'force'
  } | null>(null)
  const [delistRunning, setDelistRunning] = useState(false)

  const loadAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - 30 * 86400_000)
      const [statusData, deploymentsData, earningsData, configData] = await Promise.all([
        api.external.status(),
        api.external.deployments(statusFilter ? { status: statusFilter } : undefined),
        api.external.earnings({ from: from.toISOString(), to: to.toISOString() }),
        api.external.getConfig(),
      ])

      setStatus(statusData)
      setDeployments(deploymentsData)
      setEarnings(earningsData)

      setConfig((prev) => {
        if (prev && configDirty) return prev
        return {
          enabled: configData.config.enabled,
          simulationMode: configData.config.simulationMode,
          idleThresholdMinutes: configData.config.idleThresholdMinutes,
          demandThresholdPercent: configData.config.demandThresholdPercent,
          marginProtectionPercent: configData.config.marginProtectionPercent,
          gracePeriodSeconds: configData.config.gracePeriodSeconds,
          preferredMarkets: configData.config.preferredMarkets.length > 0
            ? configData.config.preferredMarkets
            : [...MARKETS],
        }
      })

      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load external market data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [statusFilter, configDirty])

  useEffect(() => {
    loadAll()
    const interval = setInterval(() => loadAll(), 10_000)
    return () => clearInterval(interval)
  }, [loadAll])

  async function handleSaveConfig() {
    if (!config) return
    setConfigSaving(true)
    try {
      const result = await api.external.updateConfig({
        enabled: config.enabled,
        simulationMode: config.simulationMode,
        idleThresholdMinutes: config.idleThresholdMinutes,
        demandThresholdPercent: config.demandThresholdPercent,
        marginProtectionPercent: config.marginProtectionPercent,
        gracePeriodSeconds: config.gracePeriodSeconds,
        preferredMarkets: config.preferredMarkets,
      })
      addToast({ type: 'success', title: 'Config saved', message: 'Overflow settings updated' })
      setConfigDirty(false)
      setConfig({
        enabled: result.config.enabled,
        simulationMode: result.config.simulationMode,
        idleThresholdMinutes: result.config.idleThresholdMinutes,
        demandThresholdPercent: result.config.demandThresholdPercent,
        marginProtectionPercent: result.config.marginProtectionPercent,
        gracePeriodSeconds: result.config.gracePeriodSeconds,
        preferredMarkets: result.config.preferredMarkets.length > 0
          ? result.config.preferredMarkets
          : [...MARKETS],
      })
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Save failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setConfigSaving(false)
    }
  }

  function mutateConfig(patch: Partial<OverflowConfigForm>) {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev))
    setConfigDirty(true)
  }

  function moveMarket(market: ExternalMarket, direction: -1 | 1) {
    if (!config) return
    const markets = [...config.preferredMarkets]
    const idx = markets.indexOf(market)
    if (idx < 0) return
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= markets.length) return
    const tmp = markets[idx]
    markets[idx] = markets[newIdx]
    markets[newIdx] = tmp
    mutateConfig({ preferredMarkets: markets })
  }

  async function confirmDelist() {
    if (!delistTarget) return
    setDelistRunning(true)
    try {
      await api.external.delistNode(delistTarget.nodeId, delistTarget.mode, 'admin manual delist')
      addToast({
        type: 'success',
        title: 'Delist requested',
        message: `${delistTarget.mode.toUpperCase()} delist in progress`,
      })
      setDelistTarget(null)
      await loadAll()
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Delist failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setDelistRunning(false)
    }
  }

  const earningsChartData = useMemo(() => {
    if (!earnings) return []
    return [
      {
        date: new Date(earnings.periodStart).toLocaleDateString(),
        AKASH: earnings.byMarket.AKASH ?? 0,
        IONET: earnings.byMarket.IONET ?? 0,
        VASTAI: earnings.byMarket.VASTAI ?? 0,
      },
      {
        date: new Date(earnings.periodEnd).toLocaleDateString(),
        AKASH: earnings.byMarket.AKASH ?? 0,
        IONET: earnings.byMarket.IONET ?? 0,
        VASTAI: earnings.byMarket.VASTAI ?? 0,
      },
    ]
  }, [earnings])

  const activeDeployments = deployments?.deployments ?? []
  const counts = deployments?.counts ?? { PENDING: 0, ACTIVE: 0, TERMINATING: 0, TERMINATED: 0, FAILED: 0 }

  return (
    <DashboardShell
      title="External Markets"
      subtitle="Akash, IO.net, Vast.ai overflow"
      liveLabel={status?.simulationMode ? 'SIMULATION' : 'LIVE'}
      onRefresh={() => loadAll(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <MetricTriad
          metrics={[
            {
              label: 'Total External (30d)',
              value: formatCurrency(earnings?.totalUsd ?? 0),
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: 'Active Deployments',
              value: String(counts.ACTIVE ?? 0),
              detail: `${counts.PENDING ?? 0} pending`,
              icon: Activity,
              tone: 'blue',
            },
            {
              label: 'Markets',
              value: String(status?.markets.filter(m => m.healthy).length ?? 0),
              detail: `of ${MARKETS.length} healthy`,
              icon: Globe,
              tone: 'purple',
            },
          ]}
        />

        {error && (
          <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-error/10 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-error" />
            </div>
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {!loading && config && (
          <SectionCard
            title="Overflow Configuration"
            icon={SettingsIcon}
            actions={
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveConfig}
                disabled={!configDirty || configSaving}
                loading={configSaving}
                icon={<Save className="w-4 h-4" />}
              >
                Save
              </Button>
            }
          >
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ToggleRow
                  label="Overflow enabled"
                  helpText="Master switch for external market routing"
                  checked={config.enabled}
                  onChange={(v) => mutateConfig({ enabled: v })}
                  disabled={configSaving}
                />
                <ToggleRow
                  label="Simulation mode"
                  helpText={
                    config.simulationMode
                      ? 'Safe, no real deployments will be created'
                      : 'Live mode requires API credentials'
                  }
                  warning={!config.simulationMode}
                  checked={config.simulationMode}
                  onChange={(v) => mutateConfig({ simulationMode: v })}
                  disabled={configSaving}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <NumberField
                  label="Idle threshold (minutes)"
                  helpText="Minutes a node must be idle before overflow kicks in"
                  value={config.idleThresholdMinutes}
                  min={1}
                  max={1440}
                  onChange={(v) => mutateConfig({ idleThresholdMinutes: v })}
                  disabled={configSaving}
                />
                <NumberField
                  label="Demand threshold (%)"
                  helpText="Internal utilisation ceiling before overflowing"
                  value={config.demandThresholdPercent}
                  min={0}
                  max={100}
                  onChange={(v) => mutateConfig({ demandThresholdPercent: v })}
                  disabled={configSaving}
                />
                <NumberField
                  label="Margin protection (%)"
                  helpText="Skip external routing if margin falls below this"
                  value={config.marginProtectionPercent}
                  min={0}
                  max={100}
                  onChange={(v) => mutateConfig({ marginProtectionPercent: v })}
                  disabled={configSaving}
                />
                <NumberField
                  label="Grace period (seconds)"
                  helpText="Wait before delisting when internal demand returns"
                  value={config.gracePeriodSeconds}
                  min={0}
                  max={3600}
                  onChange={(v) => mutateConfig({ gracePeriodSeconds: v })}
                  disabled={configSaving}
                />
              </div>

              <div>
                <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Preferred markets</p>
                <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                  Higher priority markets are tried first when overflowing
                </p>
                <div className="flex flex-wrap gap-2">
                  {config.preferredMarkets.map((market, idx) => (
                    <div
                      key={market}
                      className="inline-flex items-center gap-2 pl-3 pr-1 py-1.5 rounded-lg border border-white/10 bg-white/5"
                    >
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {idx + 1}. {MARKET_LABELS[market]}
                      </span>
                      <div className="flex">
                        <button
                          onClick={() => moveMarket(market, -1)}
                          disabled={idx === 0 || configSaving}
                          className="p-1 rounded hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          style={{ color: 'var(--text-muted)' }}
                          title="Move up"
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          onClick={() => moveMarket(market, 1)}
                          disabled={idx === config.preferredMarkets.length - 1 || configSaving}
                          className="p-1 rounded hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          style={{ color: 'var(--text-muted)' }}
                          title="Move down"
                        >
                          <ArrowDown size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {configDirty && !configSaving && (
                <p className="text-xs text-warning">Unsaved changes</p>
              )}
            </div>
          </SectionCard>
        )}

        <SectionCard title="Active Deployments" icon={Server}>
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.label}
                onClick={() => setStatusFilter(f.value)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-all ${
                  statusFilter === f.value
                    ? 'bg-accent text-background'
                    : 'bg-surface hover:bg-surface-hover'
                }`}
                style={statusFilter === f.value ? undefined : { color: 'var(--text-secondary)' }}
              >
                {f.label}
                {f.value && f.value.split(',').length === 1 && (
                  <span className="ml-1.5 opacity-70">
                    ({counts[f.value as DeploymentStatus] ?? 0})
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider border-b border-white/10" style={{ color: 'var(--text-muted)' }}>
                  <th className="py-3 px-3 font-medium">Node</th>
                  <th className="py-3 px-3 font-medium">GPU</th>
                  <th className="py-3 px-3 font-medium">Market</th>
                  <th className="py-3 px-3 font-medium">Status</th>
                  <th className="py-3 px-3 font-medium text-right">Rate/hr</th>
                  <th className="py-3 px-3 font-medium text-right">Cost</th>
                  <th className="py-3 px-3 font-medium text-right">Earnings</th>
                  <th className="py-3 px-3 font-medium">Age</th>
                  <th className="py-3 px-3 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {activeDeployments.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>
                      No deployments match this filter
                    </td>
                  </tr>
                ) : (
                  activeDeployments.map((d) => (
                    <tr key={d.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      <td className="py-3 px-3">
                        <Link
                          href={`/nodes/${d.nodeId}`}
                          className="text-accent hover:underline font-mono text-xs"
                        >
                          {d.nodeId.slice(0, 8)}...
                        </Link>
                      </td>
                      <td className="py-3 px-3" style={{ color: 'var(--text-primary)' }}>{d.node.gpuTier}</td>
                      <td className="py-3 px-3">
                        <MarketPill market={d.market} />
                      </td>
                      <td className="py-3 px-3">
                        <StatusBadge status={d.status as DeploymentStatus} />
                      </td>
                      <td className="py-3 px-3 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>
                        ${d.ratePerHour.toFixed(2)}
                      </td>
                      <td className="py-3 px-3 text-right text-error tabular-nums">
                        {formatCurrency(d.costAccumulated)}
                      </td>
                      <td className="py-3 px-3 text-right text-accent tabular-nums">
                        {formatCurrency(d.earningsAccumulated)}
                      </td>
                      <td className="py-3 px-3" style={{ color: 'var(--text-muted)' }}>
                        {timeAgo(d.createdAt)}
                      </td>
                      <td className="py-3 px-3 relative">
                        {(d.status === 'ACTIVE' || d.status === 'PENDING') && (
                          <>
                            <button
                              onClick={() =>
                                setActionMenuFor(actionMenuFor === d.id ? null : d.id)
                              }
                              className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors"
                              style={{ color: 'var(--text-muted)' }}
                              title="Actions"
                            >
                              <MoreVertical size={16} />
                            </button>
                            {actionMenuFor === d.id && (
                              <>
                                <div
                                  className="fixed inset-0 z-10"
                                  onClick={() => setActionMenuFor(null)}
                                />
                                <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-border rounded-lg shadow-xl z-20 overflow-hidden">
                                  <button
                                    onClick={() => {
                                      setActionMenuFor(null)
                                      setDelistTarget({
                                        nodeId: d.nodeId,
                                        deploymentId: d.id,
                                        mode: 'safe',
                                      })
                                    }}
                                    className="w-full text-left px-4 py-2 text-sm hover:bg-surface-hover transition-colors"
                                  >
                                    Delist (SAFE)
                                  </button>
                                  <button
                                    onClick={() => {
                                      setActionMenuFor(null)
                                      setDelistTarget({
                                        nodeId: d.nodeId,
                                        deploymentId: d.id,
                                        mode: 'force',
                                      })
                                    }}
                                    className="w-full text-left px-4 py-2 text-sm text-error hover:bg-error/10 transition-colors"
                                  >
                                    Delist (FORCE)
                                  </button>
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard
          title="External Earnings"
          icon={DollarSign}
          badge={earnings && (
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] ml-2" style={{ color: 'var(--text-muted)' }}>
              {new Date(earnings.periodStart).toLocaleDateString()} - {new Date(earnings.periodEnd).toLocaleDateString()}
            </span>
          )}
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <EarningsSummaryCard
                label="Total External"
                value={formatCurrency(earnings?.totalUsd ?? 0)}
                color="#22c55e"
                icon={<DollarSign className="w-4 h-4" />}
              />
              {MARKETS.map((market) => (
                <EarningsSummaryCard
                  key={market}
                  label={MARKET_LABELS[market]}
                  value={formatCurrency(earnings?.byMarket[market] ?? 0)}
                  color={MARKET_COLORS[market]}
                  icon={<Globe className="w-4 h-4" />}
                />
              ))}
            </div>

            {earningsChartData.length > 0 && (earnings?.totalUsd ?? 0) > 0 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={earningsChartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      tickFormatter={(v: number) => `$${v}`}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--glass-bg)',
                        border: '1px solid var(--glass-border)',
                        borderRadius: '8px',
                        color: 'var(--text-primary)',
                      }}
                      formatter={(value) => [`$${Number(value).toFixed(2)}`, '']}
                    />
                    <Legend />
                    {MARKETS.map((market) => (
                      <Line
                        key={market}
                        type="monotone"
                        dataKey={market}
                        name={MARKET_LABELS[market]}
                        stroke={MARKET_COLORS[market]}
                        strokeWidth={2}
                        dot={{ r: 4 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-32 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No external earnings recorded in this window
              </div>
            )}

            {earnings && earnings.byNode.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Top earning nodes</p>
                <div className="space-y-2">
                  {earnings.byNode.slice(0, 5).map((n) => (
                    <div
                      key={n.nodeId}
                      className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10"
                    >
                      <Link
                        href={`/nodes/${n.nodeId}`}
                        className="text-sm text-accent hover:underline font-mono"
                      >
                        {n.nodeId.slice(0, 10)}...
                      </Link>
                      <span className="text-sm font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>
                        {formatCurrency(n.totalUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        {(status?.markets ?? []).map((market) => (
          <MarketStatusCard key={market.market} market={market} />
        ))}

        {status?.simulationMode && (
          <SectionCard title="Mode" icon={Beaker}>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-full bg-warning/10 text-warning border border-warning/30">
              <Beaker className="w-3.5 h-3.5" />
              Simulation Mode
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              No real deployments are created in simulation mode.
            </p>
          </SectionCard>
        )}
      </DashboardRightRail>

      <ConfirmModal
        isOpen={delistTarget !== null}
        onClose={() => !delistRunning && setDelistTarget(null)}
        onConfirm={confirmDelist}
        title={delistTarget?.mode === 'force' ? 'Force delist node?' : 'Delist node (safe)?'}
        message={
          delistTarget?.mode === 'force'
            ? 'Force delisting immediately terminates the external deployment. Any in-flight work will be dropped.'
            : 'Safe delisting marks the deployment as TERMINATING. It will clean up once all current work completes.'
        }
        confirmText={delistTarget?.mode === 'force' ? 'Force Delist' : 'Delist'}
        variant={delistTarget?.mode === 'force' ? 'danger' : 'warning'}
        loading={delistRunning}
      />
    </DashboardShell>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  helpText,
  checked,
  warning,
  onChange,
  disabled,
}: {
  label: string
  helpText: string
  checked: boolean
  warning?: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-4 bg-white/5 rounded-xl border border-white/10">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</p>
        <p className={`text-xs mt-1 ${warning ? 'text-warning' : ''}`} style={warning ? undefined : { color: 'var(--text-muted)' }}>{helpText}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed ${
          checked ? 'bg-accent' : 'bg-surface-hover'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}

function NumberField({
  label,
  helpText,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string
  helpText: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
  disabled?: boolean
}) {
  return (
    <div className="p-4 bg-white/5 rounded-xl border border-white/10">
      <label className="block">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!Number.isNaN(parsed)) onChange(parsed)
          }}
          disabled={disabled}
          className="mt-2 w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed tabular-nums"
          style={{ color: 'var(--text-primary)' }}
        />
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{helpText}</p>
      </label>
    </div>
  )
}

function MarketStatusCard({
  market,
}: {
  market: StatusResponse['markets'][number]
}) {
  const { dotColor, label, badgeStyle } = getHealthStyle(market)
  return (
    <SectionCard title={MARKET_LABELS[market.market]} icon={Globe} badge={
      <span className={`px-2.5 py-1 text-xs font-medium rounded-lg ml-2 ${badgeStyle}`}>
        {!market.enabled
          ? 'Disabled'
          : market.autoDisabled
            ? 'Auto-disabled'
            : 'Enabled'}
      </span>
    }>
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>

      <div className="space-y-2 mb-4 text-xs">
        <div className="flex items-center justify-between">
          <span style={{ color: 'var(--text-muted)' }}>Failures</span>
          <span className={market.failureCount > 0 ? 'text-error font-medium' : ''} style={market.failureCount > 0 ? undefined : { color: 'var(--text-secondary)' }}>
            {market.failureCount}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span style={{ color: 'var(--text-muted)' }}>Last success</span>
          <span style={{ color: 'var(--text-secondary)' }}>{timeAgo(market.lastSuccess)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span style={{ color: 'var(--text-muted)' }}>Last failure</span>
          <span style={{ color: 'var(--text-secondary)' }}>{timeAgo(market.lastFailure)}</span>
        </div>
      </div>

      <div className="pt-3 border-t border-white/10">
        <p className="text-xs mb-2 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Current rates ($/hr)</p>
        <div className="grid grid-cols-3 gap-2 text-xs">
          {GPU_TIERS.map((tier) => {
            const rate = market.latestRates[tier]
            return (
              <div key={tier} className="text-center p-2 bg-white/5 rounded border border-white/5">
                <p style={{ color: 'var(--text-muted)' }}>{tier}</p>
                <p className="font-semibold tabular-nums mt-0.5" style={{ color: 'var(--text-primary)' }}>
                  {rate && rate.available ? `$${rate.ratePerHour.toFixed(2)}` : '-'}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </SectionCard>
  )
}

function getHealthStyle(market: StatusResponse['markets'][number]): {
  dotColor: string
  label: string
  badgeStyle: string
} {
  if (!market.enabled) {
    return {
      dotColor: 'bg-gray-500',
      label: 'Disabled',
      badgeStyle: 'bg-gray-500/10 text-gray-400 border border-gray-500/30',
    }
  }
  if (market.autoDisabled) {
    return {
      dotColor: 'bg-warning',
      label: 'Auto-disabled',
      badgeStyle: 'bg-warning/10 text-warning border border-warning/30',
    }
  }
  if (market.healthy) {
    return {
      dotColor: 'bg-accent',
      label: 'Healthy',
      badgeStyle: 'bg-accent/10 text-accent border border-accent/30',
    }
  }
  return {
    dotColor: 'bg-error',
    label: 'Failing',
    badgeStyle: 'bg-error/10 text-error border border-error/30',
  }
}

function MarketPill({ market }: { market: ExternalMarket }) {
  const color = MARKET_COLORS[market]
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-md"
      style={{ background: `${color}1a`, color, border: `1px solid ${color}33` }}
    >
      {MARKET_LABELS[market]}
    </span>
  )
}

function StatusBadge({ status }: { status: DeploymentStatus }) {
  const styles: Record<DeploymentStatus, { cls: string; icon: JSX.Element }> = {
    PENDING: {
      cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
      icon: <Clock className="w-3 h-3" />,
    },
    ACTIVE: {
      cls: 'bg-accent/10 text-accent border-accent/30',
      icon: <Activity className="w-3 h-3" />,
    },
    TERMINATING: {
      cls: 'bg-warning/10 text-warning border-warning/30',
      icon: <Clock className="w-3 h-3" />,
    },
    TERMINATED: {
      cls: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
      icon: <CheckCircle2 className="w-3 h-3" />,
    },
    FAILED: {
      cls: 'bg-error/10 text-error border-error/30',
      icon: <XCircle className="w-3 h-3" />,
    },
  }
  const entry = styles[status]
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-md border ${entry.cls}`}>
      {entry.icon}
      {status}
    </span>
  )
}

function EarningsSummaryCard({
  label,
  value,
  color,
  icon,
}: {
  label: string
  value: string
  color: string
  icon: JSX.Element
}) {
  return (
    <div className="p-4 bg-white/5 rounded-xl border border-white/10">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color }}>{icon}</span>
        <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums" style={{ color }}>
        {value}
      </p>
    </div>
  )
}
