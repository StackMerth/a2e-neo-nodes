'use client'

import { useState } from 'react'
import { GitBranch, Star, Globe, Clock, Map, AlertTriangle, Shield, CircleCheck, Route } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'
import {
  DashboardShell,
  SectionCard,
  DataTableCard,
  FormCard,
  FormSection,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

const GPU_TIERS = [
  { value: 'H100', label: 'NVIDIA H100 - $140.15/day retail' },
  { value: 'H200', label: 'NVIDIA H200 - $179.85/day retail' },
  { value: 'B200', label: 'NVIDIA B200 - $321.10/day retail' },
  { value: 'B300', label: 'NVIDIA B300 - $431.75/day retail' },
  { value: 'GB300', label: 'NVIDIA GB300 - $499.35/day retail' },
]

interface RoutingResult {
  jobId: string
  deploymentId: string
  market: string
  ratePerHour: number
  ratePerDay: number
  reason: string
  yieldFloorApplied: boolean
  decisionTimeMs: number
  timestamp: string
}

type RoutingRow = RoutingResult & Record<string, unknown>

export default function RoutingPage() {
  const [deploymentId, setDeploymentId] = useState('#' + Math.floor(100 + Math.random() * 900))
  const [gpuTier, setGpuTier] = useState('H100')
  const [hasInternalDemand, setHasInternalDemand] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<RoutingResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<RoutingResult[]>([])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const response = await api.route({
        deploymentId,
        gpuTier,
        hasInternalDemand,
      })
      setResult(response)
      setHistory((prev) => [response, ...prev].slice(0, 20))
      setDeploymentId('#' + Math.floor(100 + Math.random() * 900))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Routing request failed')
    } finally {
      setLoading(false)
    }
  }

  const getMarketBadgeStyle = (market: string) => {
    switch (market) {
      case 'INTERNAL': return { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' }
      case 'AKASH':    return { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' }
      case 'IONET':    return { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' }
      default:         return { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
    }
  }

  const columns: Array<DataTableColumn<RoutingRow>> = [
    {
      key: 'deploymentId',
      header: 'Deployment',
      render: (h, idx) => (
        <span className="flex items-center gap-2">
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{h.deploymentId}</span>
          {idx === 0 && (
            <span
              className="px-2 py-0.5 text-[10px] rounded-full font-medium"
              style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success)' }}
            >
              Latest
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'market',
      header: 'Market',
      render: (h) => {
        const ss = getMarketBadgeStyle(h.market)
        return (
          <span className="px-3 py-1 rounded-md text-xs font-medium" style={{ background: ss.bg, color: ss.color }}>
            {h.market}
          </span>
        )
      },
    },
    {
      key: 'ratePerDay',
      header: 'Rate/Day',
      align: 'right',
      mono: true,
      render: (h) => `$${h.ratePerDay.toFixed(2)}`,
    },
    {
      key: 'yieldFloorApplied',
      header: 'Floor',
      align: 'center',
      render: (h) => h.yieldFloorApplied ? (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--warning)' }}>
          <Shield size={12} />
          Yes
        </span>
      ) : (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>No</span>
      ),
    },
    {
      key: 'decisionTimeMs',
      header: 'Time',
      align: 'right',
      mono: true,
      render: (h) => `${h.decisionTimeMs}ms`,
    },
  ]

  return (
    <DashboardShell
      title="Routing Simulator"
      subtitle="Test market routing decisions and view recent history"
    >
      <div className="lg:col-span-3 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <FormCard
            title="Routing Request"
            description="Configure parameters for POST /v1/route"
            icon={GitBranch}
          >
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="Deployment ID"
                value={deploymentId}
                onChange={(e) => setDeploymentId(e.target.value)}
                placeholder="#123"
              />

              <Select
                label="GPU Tier"
                value={gpuTier}
                onChange={(e) => setGpuTier(e.target.value)}
                options={GPU_TIERS}
              />

              <FormSection title="Internal Demand">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setHasInternalDemand(false)}
                    className="p-4 rounded-md border-2 transition-all text-left"
                    style={{
                      borderColor: !hasInternalDemand ? 'var(--primary)' : 'var(--border-color)',
                      background: !hasInternalDemand ? 'rgba(34,197,94,0.05)' : 'var(--bg-elevated)',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <Globe size={18} style={{ color: !hasInternalDemand ? 'var(--primary)' : 'var(--text-muted)' }} />
                      <div>
                        <p className="text-sm font-medium" style={{ color: !hasInternalDemand ? 'var(--primary)' : 'var(--text-primary)' }}>
                          No Demand
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Route to external</p>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setHasInternalDemand(true)}
                    className="p-4 rounded-md border-2 transition-all text-left"
                    style={{
                      borderColor: hasInternalDemand ? 'var(--primary)' : 'var(--border-color)',
                      background: hasInternalDemand ? 'rgba(34,197,94,0.05)' : 'var(--bg-elevated)',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <Star size={18} style={{ color: hasInternalDemand ? 'var(--primary)' : 'var(--text-muted)' }} />
                      <div>
                        <p className="text-sm font-medium" style={{ color: hasInternalDemand ? 'var(--primary)' : 'var(--text-primary)' }}>
                          Has Demand
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Premium retail rate</p>
                      </div>
                    </div>
                  </button>
                </div>
              </FormSection>

              {error && (
                <div
                  className="p-3 rounded-md flex items-center gap-3"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
                  <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>
                </div>
              )}

              <Button type="submit" loading={loading} variant="gradient" className="w-full" size="lg" icon={<Map className="w-4 h-4" />}>
                Send Routing Request
              </Button>
            </form>
          </FormCard>

          <SectionCard title="Routing Decision" icon={Route}>
            {result ? (
              <div className="space-y-5">
                <div
                  className="p-5 rounded-md text-center"
                  style={{
                    background: getMarketBadgeStyle(result.market).bg,
                    color: getMarketBadgeStyle(result.market).color,
                  }}
                >
                  <p className="text-xs font-mono uppercase tracking-wider mb-1 opacity-80">Selected Market</p>
                  <p className="font-display text-3xl tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                    {result.market}
                  </p>
                </div>

                <div
                  className="p-4 rounded-md"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
                        Effective Rate
                      </p>
                      <p className="font-display text-2xl" style={{ color: 'var(--text-primary)' }}>
                        ${result.ratePerDay.toFixed(2)}
                        <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-muted)' }}>/day</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Hourly</p>
                      <p className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                        ${result.ratePerHour.toFixed(4)}/hr
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-md" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-xs font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Reason</p>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{result.reason}</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div
                    className="p-3 rounded-md"
                    style={{
                      background: result.yieldFloorApplied ? 'rgba(245,158,11,0.1)' : 'var(--bg-elevated)',
                      border: result.yieldFloorApplied ? '1px solid rgba(245,158,11,0.2)' : '1px solid var(--border-color)',
                    }}
                  >
                    <p className="text-xs font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Yield Floor</p>
                    <div className="flex items-center gap-2">
                      {result.yieldFloorApplied ? (
                        <Shield size={16} style={{ color: 'var(--warning)' }} />
                      ) : (
                        <CircleCheck size={16} style={{ color: 'var(--success)' }} />
                      )}
                      <p className="text-sm font-medium" style={{ color: result.yieldFloorApplied ? 'var(--warning)' : 'var(--success)' }}>
                        {result.yieldFloorApplied ? 'Applied' : 'Not Needed'}
                      </p>
                    </div>
                  </div>
                  <div className="p-3 rounded-md" style={{ background: 'var(--bg-elevated)' }}>
                    <p className="text-xs font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Decision</p>
                    <div className="flex items-center gap-2">
                      <Clock size={16} style={{ color: '#8b5cf6' }} />
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{result.decisionTimeMs}ms</p>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-md" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-xs font-mono uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Job ID</p>
                  <p className="font-mono text-xs break-all p-2 rounded" style={{ color: 'var(--text-secondary)', background: 'var(--bg-primary)' }}>
                    {result.jobId}
                  </p>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={Map}
                title="No Decision Yet"
                description="Configure your routing parameters and send a request to see the decision"
              />
            )}
          </SectionCard>
        </div>

        <DataTableCard<RoutingRow>
          title="Routing History"
          icon={Route}
          columns={columns}
          rows={history as RoutingRow[]}
          rowKey={(h) => h.jobId}
          empty={
            <EmptyState
              icon={Route}
              title="No routing decisions yet"
              description="Submit a routing request above to see decisions appear here."
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
