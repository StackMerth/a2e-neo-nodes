'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Globe,
  RefreshCw,
  AlertTriangle,
  Clock,
  Shield,
  Server,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
  Save,
  MoreVertical,
  CheckCircle2,
  XCircle,
  Activity,
  DollarSign,
  Beaker,
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
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

// Active external markets only. AKASH and VASTAI were never integrated
// (they were seed-test-data placeholders) — removed so the admin
// dashboard reflects real supply paths. Cleanup script
// scripts/clean-seed-test-data.ts removes any residual rows from those
// market values.
type ExternalMarket = 'IONET' | 'LAMBDA' | 'RUNPOD' | 'PHALA'
type DeploymentStatus = 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'

const MARKETS: ReadonlyArray<ExternalMarket> = ['IONET', 'LAMBDA', 'RUNPOD', 'PHALA']
const GPU_TIERS = ['H100', 'H200', 'B200']

const STATUS_FILTERS: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: 'All', value: 'PENDING,ACTIVE,TERMINATING,TERMINATED,FAILED' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Terminating', value: 'TERMINATING' },
]

const MARKET_COLORS: Record<ExternalMarket, string> = {
  IONET: '#8b5cf6',
  LAMBDA: '#22c55e',
  RUNPOD: '#3b82f6',
  PHALA: '#a855f7',
}

const MARKET_LABELS: Record<ExternalMarket, string> = {
  IONET: 'IO.net',
  LAMBDA: 'Lambda',
  RUNPOD: 'RunPod',
  PHALA: 'Phala',
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
  if (!date) return '—'
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
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
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  const [configExpanded, setConfigExpanded] = useState(true)
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

  const loadAll = useCallback(async () => {
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

      // Only overwrite config form when the user has no unsaved edits.
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

      setLastUpdated(new Date().toISOString())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load external market data')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, configDirty])

  useEffect(() => {
    loadAll()
    const interval = setInterval(loadAll, 10_000)
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

  // Build an earnings time series for the chart. The /earnings endpoint
  // returns aggregates rather than a daily time series, so we render the
  // 30-day totals as a single labelled point per market alongside summary
  // cards — consistent with the task brief's fallback instruction.
  const earningsChartData = useMemo(() => {
    if (!earnings) return []
    // Markets reflect the active external networks. AKASH and VASTAI
    // were removed when ExternalMarket was narrowed to currently-
    // integrated providers; the byMarket object on the wire still
    // returns numbers keyed by all enum values it knows about, but
    // we only chart the active ones to keep the chart honest.
    return [
      {
        date: new Date(earnings.periodStart).toLocaleDateString(),
        IONET: earnings.byMarket.IONET ?? 0,
        LAMBDA: earnings.byMarket.LAMBDA ?? 0,
        RUNPOD: earnings.byMarket.RUNPOD ?? 0,
        PHALA: earnings.byMarket.PHALA ?? 0,
      },
      {
        date: new Date(earnings.periodEnd).toLocaleDateString(),
        IONET: earnings.byMarket.IONET ?? 0,
        LAMBDA: earnings.byMarket.LAMBDA ?? 0,
        RUNPOD: earnings.byMarket.RUNPOD ?? 0,
        PHALA: earnings.byMarket.PHALA ?? 0,
      },
    ]
  }, [earnings])

  const activeDeployments = deployments?.deployments ?? []
  const counts = deployments?.counts ?? { PENDING: 0, ACTIVE: 0, TERMINATING: 0, TERMINATED: 0, FAILED: 0 }

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Header */}
      <motion.div variants={item}>
        <div className="dash-header">
          <div className="dash-header-left">
            <h1><Globe size={28} /> External Markets</h1>
            <p className="text-sm text-text-muted mt-1">Monitor overflow on Akash, IO.net, and Vast.ai</p>
            {lastUpdated && (
              <span className="dash-date-badge">
                <Clock size={14} />
                Updated {new Date(lastUpdated).toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="dash-header-right flex items-center gap-3">
            {status?.simulationMode && (
              <span className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-full bg-warning/10 text-warning border border-warning/30">
                <Beaker className="w-3.5 h-3.5" />
                Simulation Mode
              </span>
            )}
            <button className="dash-refresh-btn" onClick={loadAll} title="Refresh">
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>
        </div>
      </motion.div>

      {error && (
        <motion.div variants={item} className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-error/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-error" />
          </div>
          <p className="text-error text-sm">{error}</p>
        </motion.div>
      )}

      {loading && !status ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-12 h-12 rounded-xl bg-surface-hover flex items-center justify-center mb-4">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
          <p className="text-text-muted">Loading external markets...</p>
        </div>
      ) : (
        <>
          {/* B) Overflow Config */}
          {config && (
            <motion.div variants={item}>
              <Card
                variant="glass"
                className="bg-white/5 backdrop-blur-xl border border-white/10"
                action={
                  <button
                    onClick={() => setConfigExpanded((v) => !v)}
                    className="p-2 rounded-lg hover:bg-surface-hover transition-colors text-text-muted"
                    title={configExpanded ? 'Collapse' : 'Expand'}
                  >
                    {configExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>
                }
                title="Overflow Configuration"
                description="Controls when and how idle capacity spills to external markets"
              >
                {configExpanded && (
                  <div className="space-y-6 mt-4">
                    {/* Toggles */}
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
                            ? 'Safe — no real deployments will be created'
                            : 'Live mode requires API credentials'
                        }
                        warning={!config.simulationMode}
                        checked={config.simulationMode}
                        onChange={(v) => mutateConfig({ simulationMode: v })}
                        disabled={configSaving}
                      />
                    </div>

                    {/* Numeric inputs */}
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

                    {/* Preferred markets */}
                    <div>
                      <p className="text-sm font-medium text-text-primary mb-2">Preferred markets</p>
                      <p className="text-xs text-text-muted mb-3">
                        Higher priority markets are tried first when overflowing
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {config.preferredMarkets.map((market, idx) => (
                          <div
                            key={market}
                            className="inline-flex items-center gap-2 pl-3 pr-1 py-1.5 rounded-lg border border-white/10 bg-white/5"
                          >
                            <span className="text-sm font-medium text-text-primary">
                              {idx + 1}. {MARKET_LABELS[market]}
                            </span>
                            <div className="flex">
                              <button
                                onClick={() => moveMarket(market, -1)}
                                disabled={idx === 0 || configSaving}
                                className="p-1 rounded hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-text-muted"
                                title="Move up"
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                onClick={() => moveMarket(market, 1)}
                                disabled={idx === config.preferredMarkets.length - 1 || configSaving}
                                className="p-1 rounded hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-text-muted"
                                title="Move down"
                              >
                                <ArrowDown size={14} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Save button */}
                    <div className="flex items-center gap-3 pt-2 border-t border-white/10">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSaveConfig}
                        disabled={!configDirty || configSaving}
                        loading={configSaving}
                        icon={<Save className="w-4 h-4" />}
                      >
                        Save changes
                      </Button>
                      {configDirty && !configSaving && (
                        <span className="text-xs text-warning">Unsaved changes</span>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            </motion.div>
          )}

          {/* C) Market status cards */}
          <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {(status?.markets ?? []).map((market) => (
              <MarketStatusCard key={market.market} market={market} />
            ))}
          </motion.div>

          {/* D) Active deployments */}
          <motion.div variants={item}>
            <Card
              variant="glass"
              className="bg-white/5 backdrop-blur-xl border border-white/10"
              title="Active Deployments"
              description="External deployments currently live on third-party markets"
            >
              {/* Status filter chips */}
              <div className="flex items-center gap-2 flex-wrap mt-4 mb-4">
                {STATUS_FILTERS.map((f) => (
                  <button
                    key={f.label}
                    onClick={() => setStatusFilter(f.value)}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-all ${
                      statusFilter === f.value
                        ? 'bg-accent text-background'
                        : 'bg-surface text-text-secondary hover:bg-surface-hover'
                    }`}
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

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-text-muted uppercase tracking-wider border-b border-white/10">
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
                        <td colSpan={9} className="py-10 text-center text-text-muted">
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
                              {d.nodeId.slice(0, 8)}…
                            </Link>
                          </td>
                          <td className="py-3 px-3 text-text-primary">{d.node.gpuTier}</td>
                          <td className="py-3 px-3">
                            <MarketPill market={d.market} />
                          </td>
                          <td className="py-3 px-3">
                            <StatusBadge status={d.status as DeploymentStatus} />
                          </td>
                          <td className="py-3 px-3 text-right text-text-primary tabular-nums">
                            ${d.ratePerHour.toFixed(2)}
                          </td>
                          <td className="py-3 px-3 text-right text-error tabular-nums">
                            {formatCurrency(d.costAccumulated)}
                          </td>
                          <td className="py-3 px-3 text-right text-accent tabular-nums">
                            {formatCurrency(d.earningsAccumulated)}
                          </td>
                          <td className="py-3 px-3 text-text-muted">
                            {timeAgo(d.createdAt)}
                          </td>
                          <td className="py-3 px-3 relative">
                            {(d.status === 'ACTIVE' || d.status === 'PENDING') && (
                              <>
                                <button
                                  onClick={() =>
                                    setActionMenuFor(actionMenuFor === d.id ? null : d.id)
                                  }
                                  className="p-1.5 rounded-lg hover:bg-surface-hover transition-colors text-text-muted"
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
            </Card>
          </motion.div>

          {/* E) External earnings — summary cards + chart */}
          <motion.div variants={item}>
            <Card
              variant="glass"
              className="bg-white/5 backdrop-blur-xl border border-white/10"
              title="External Earnings"
              description={
                earnings
                  ? `${new Date(earnings.periodStart).toLocaleDateString()} → ${new Date(earnings.periodEnd).toLocaleDateString()}`
                  : 'Last 30 days'
              }
            >
              <div className="space-y-6 mt-4">
                {/* Summary cards */}
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

                {/* Chart */}
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
                  <div className="h-32 flex items-center justify-center text-text-muted text-sm">
                    No external earnings recorded in this window
                  </div>
                )}

                {/* Top earners */}
                {earnings && earnings.byNode.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-text-primary mb-3">Top earning nodes</p>
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
                            {n.nodeId.slice(0, 10)}…
                          </Link>
                          <span className="text-sm font-medium text-text-primary tabular-nums">
                            {formatCurrency(n.totalUsd)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </motion.div>
        </>
      )}

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
    </motion.div>
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
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className={`text-xs mt-1 ${warning ? 'text-warning' : 'text-text-muted'}`}>{helpText}</p>
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
        <span className="text-sm font-medium text-text-primary">{label}</span>
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
          className="mt-2 w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed tabular-nums"
        />
        <p className="text-xs text-text-muted mt-2">{helpText}</p>
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
    <Card variant="glass" className="bg-white/5 backdrop-blur-xl border border-white/10">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
            <Globe className="w-5 h-5 text-text-secondary" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              {MARKET_LABELS[market.market]}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${dotColor}`} />
              <span className="text-xs text-text-muted">{label}</span>
            </div>
          </div>
        </div>
        <span className={`px-2.5 py-1 text-xs font-medium rounded-lg ${badgeStyle}`}>
          {!market.enabled
            ? 'Disabled'
            : market.autoDisabled
              ? 'Auto-disabled'
              : 'Enabled'}
        </span>
      </div>

      <div className="space-y-2 mb-4 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-text-muted">Failures</span>
          <span className={market.failureCount > 0 ? 'text-error font-medium' : 'text-text-secondary'}>
            {market.failureCount}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-muted">Last success</span>
          <span className="text-text-secondary">{timeAgo(market.lastSuccess)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-muted">Last failure</span>
          <span className="text-text-secondary">{timeAgo(market.lastFailure)}</span>
        </div>
      </div>

      <div className="pt-3 border-t border-white/10">
        <p className="text-xs text-text-muted mb-2 uppercase tracking-wider">Current rates ($/hr)</p>
        <div className="grid grid-cols-3 gap-2 text-xs">
          {GPU_TIERS.map((tier) => {
            const rate = market.latestRates[tier]
            return (
              <div key={tier} className="text-center p-2 bg-white/5 rounded border border-white/5">
                <p className="text-text-muted">{tier}</p>
                <p className="font-semibold text-text-primary tabular-nums mt-0.5">
                  {rate && rate.available ? `$${rate.ratePerHour.toFixed(2)}` : '—'}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </Card>
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
        <span className="text-xs text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-bold text-text-primary tabular-nums" style={{ color }}>
        {value}
      </p>
    </div>
  )
}
