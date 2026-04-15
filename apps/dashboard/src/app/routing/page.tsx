'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { FlaskConical, Star, Globe, Clock, Map, AlertTriangle, Shield, CircleCheck } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const GPU_TIERS = [
  { value: 'H100', label: 'NVIDIA H100 — $140.15/day retail' },
  { value: 'H200', label: 'NVIDIA H200 — $179.85/day retail' },
  { value: 'B200', label: 'NVIDIA B200 — $321.10/day retail' },
  { value: 'B300', label: 'NVIDIA B300 — $431.75/day retail' },
  { value: 'GB300', label: 'NVIDIA GB300 — $499.35/day retail' },
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

export default function RoutingPage() {
  const [deploymentId, setDeploymentId] = useState('#' + Math.floor(100 + Math.random() * 900))
  const [gpuTier, setGpuTier] = useState('H100')
  const [hasInternalDemand, setHasInternalDemand] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<RoutingResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<RoutingResult[]>([])

  // Stats from history
  const internalCount = history.filter(h => h.market === 'INTERNAL').length
  const akashCount = history.filter(h => h.market === 'AKASH').length
  const ionetCount = history.filter(h => h.market === 'IONET').length
  const avgDecisionTime = history.length > 0
    ? (history.reduce((sum, h) => sum + h.decisionTimeMs, 0) / history.length).toFixed(1)
    : '0'

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
      setHistory((prev) => [response, ...prev].slice(0, 10))
      setDeploymentId('#' + Math.floor(100 + Math.random() * 900))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Routing request failed')
    } finally {
      setLoading(false)
    }
  }

  const getMarketGradient = (market: string) => {
    switch (market) {
      case 'INTERNAL': return 'from-accent to-accent-hover'
      case 'AKASH': return 'from-accent-blue to-blue-600'
      case 'IONET': return 'from-accent-purple to-purple-600'
      default: return 'from-gray-500 to-gray-600'
    }
  }

  const getMarketBgColor = (market: string) => {
    switch (market) {
      case 'INTERNAL': return 'bg-accent/5 border-accent/20'
      case 'AKASH': return 'bg-accent-blue/5 border-accent-blue/20'
      case 'IONET': return 'bg-accent-purple/5 border-accent-purple/20'
      default: return 'bg-surface border-border'
    }
  }

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Hero Section */}
      <motion.div variants={item} className="relative py-8 md:py-12">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-accent/5 border border-accent/20 rounded-full mb-4 animate-slideUp">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
              </span>
              <span className="text-xs text-accent font-medium uppercase tracking-wider">Routing Simulator</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-text-primary mb-3">
              Test A<sup className="text-accent">2</sup>E Routing
            </h1>
            <p className="text-text-muted">
              Simulate routing decisions to understand how jobs are allocated across markets.
              Configure parameters and see real-time routing outcomes.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Session Stats */}
      {history.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Tests"
            value={history.length}
            variant="default"
            icon={<FlaskConical className="w-4 h-4" />}
          />
          <StatCard
            label="Internal Routes"
            value={internalCount}
            variant="accent"
            icon={<Star className="w-4 h-4" />}
          />
          <StatCard
            label="External Routes"
            value={akashCount + ionetCount}
            variant="blue"
            icon={<Globe className="w-4 h-4" />}
          />
          <StatCard
            label="Avg Decision"
            value={avgDecisionTime}
            suffix="ms"
            variant="purple"
            icon={<Clock className="w-4 h-4" />}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Request Form */}
        <Card variant="glass" title="Routing Request" description="Configure parameters for POST /v1/route">
          <form onSubmit={handleSubmit} className="space-y-6 mt-6">
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

            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary">
                Internal Demand
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setHasInternalDemand(false)}
                  className={`p-4 rounded-xl border-2 transition-all ${
                    !hasInternalDemand
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-border/80 bg-surface'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      !hasInternalDemand ? 'bg-accent/10' : 'bg-surface-hover'
                    }`}>
                      <Globe className={`w-5 h-5 ${!hasInternalDemand ? 'text-accent' : 'text-text-muted'}`} />
                    </div>
                    <div className="text-left">
                      <p className={`font-medium ${!hasInternalDemand ? 'text-accent' : 'text-text-primary'}`}>
                        No Demand
                      </p>
                      <p className="text-xs text-text-muted">Route to external</p>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setHasInternalDemand(true)}
                  className={`p-4 rounded-xl border-2 transition-all ${
                    hasInternalDemand
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-border/80 bg-surface'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      hasInternalDemand ? 'bg-accent/10' : 'bg-surface-hover'
                    }`}>
                      <Star className={`w-5 h-5 ${hasInternalDemand ? 'text-accent' : 'text-text-muted'}`} />
                    </div>
                    <div className="text-left">
                      <p className={`font-medium ${hasInternalDemand ? 'text-accent' : 'text-text-primary'}`}>
                        Has Demand
                      </p>
                      <p className="text-xs text-text-muted">Premium retail rate</p>
                    </div>
                  </div>
                </button>
              </div>
              <p className="text-xs text-text-muted">
                When internal demand exists, jobs route to INTERNAL at premium retail rate
              </p>
            </div>

            {error && (
              <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-error flex-shrink-0" />
                <p className="text-error text-sm">{error}</p>
              </div>
            )}

            <Button type="submit" loading={loading} variant="gradient" className="w-full" size="lg" icon={<Map className="w-4 h-4" />}>
              Send Routing Request
            </Button>
          </form>
        </Card>

        {/* Result Display */}
        <Card variant="glass" title="Routing Decision" description="Response from POST /v1/route">
          {result ? (
            <div className="space-y-6 mt-6">
              {/* Market Badge - Hero */}
              <div className={`p-6 rounded-2xl bg-gradient-to-r ${getMarketGradient(result.market)} text-white text-center`}>
                <p className="text-sm opacity-80 mb-1">Selected Market</p>
                <p className="text-3xl font-bold">{result.market}</p>
              </div>

              {/* Rate Card */}
              <div className={`p-5 rounded-xl border ${getMarketBgColor(result.market)}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-text-muted mb-1">Effective Rate</p>
                    <p className="text-3xl font-bold text-text-primary">
                      ${result.ratePerDay.toFixed(2)}
                      <span className="text-lg font-normal text-text-muted">/day</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-text-muted mb-1">Hourly</p>
                    <p className="text-lg font-medium text-text-secondary">${result.ratePerHour.toFixed(4)}/hr</p>
                  </div>
                </div>
              </div>

              {/* Reason */}
              <div className="p-4 bg-surface rounded-xl">
                <p className="text-xs text-text-muted uppercase tracking-wider mb-2">Reason</p>
                <p className="text-text-primary font-medium">{result.reason}</p>
              </div>

              {/* Meta Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className={`p-4 rounded-xl ${result.yieldFloorApplied ? 'bg-warning/10 border border-warning/20' : 'bg-surface'}`}>
                  <p className="text-xs text-text-muted mb-1">Yield Floor Applied</p>
                  <div className="flex items-center gap-2">
                    {result.yieldFloorApplied ? (
                      <Shield className="w-5 h-5 text-warning" />
                    ) : (
                      <CircleCheck className="w-5 h-5 text-accent" />
                    )}
                    <p className={`font-bold ${result.yieldFloorApplied ? 'text-warning' : 'text-accent'}`}>
                      {result.yieldFloorApplied ? 'Yes' : 'No'}
                    </p>
                  </div>
                </div>
                <div className="p-4 bg-surface rounded-xl">
                  <p className="text-xs text-text-muted mb-1">Decision Time</p>
                  <div className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-accent-purple" />
                    <p className="font-bold text-text-primary">{result.decisionTimeMs}ms</p>
                  </div>
                </div>
              </div>

              {/* Job ID */}
              <div className="p-4 bg-surface rounded-xl">
                <p className="text-xs text-text-muted mb-2">Job ID</p>
                <p className="font-mono text-sm text-text-secondary break-all bg-background p-3 rounded-lg border border-border">
                  {result.jobId}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-accent/10 to-accent-purple/10 flex items-center justify-center mb-6">
                <Map className="w-10 h-10 text-accent/50" />
              </div>
              <h3 className="text-lg font-medium text-text-primary mb-2">No Decision Yet</h3>
              <p className="text-sm text-text-muted text-center max-w-xs">
                Configure your routing parameters and send a request to see the decision
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* History */}
      {history.length > 0 && (
        <Card variant="glass" title="Routing History" description="Recent routing decisions from this session">
          <div className="overflow-x-auto mt-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">Deployment</th>
                  <th className="text-left py-4 px-4 text-xs text-text-muted uppercase font-medium">Market</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Rate/Day</th>
                  <th className="text-center py-4 px-4 text-xs text-text-muted uppercase font-medium">Floor</th>
                  <th className="text-right py-4 px-4 text-xs text-text-muted uppercase font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, i) => (
                  <tr
                    key={item.jobId}
                    className={`border-b border-border/50 transition-colors ${
                      i === 0 ? 'bg-accent/5' : 'hover:bg-surface-hover/50'
                    }`}
                  >
                    <td className="py-4 px-4">
                      <span className="text-sm font-medium text-text-primary">{item.deploymentId}</span>
                      {i === 0 && (
                        <span className="ml-2 px-2 py-0.5 text-[10px] bg-accent/10 text-accent rounded-full font-medium">
                          Latest
                        </span>
                      )}
                    </td>
                    <td className="py-4 px-4">
                      <span className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                        item.market === 'INTERNAL' ? 'bg-accent/10 text-accent' :
                        item.market === 'AKASH' ? 'bg-accent-blue/10 text-accent-blue' :
                        'bg-accent-purple/10 text-accent-purple'
                      }`}>
                        {item.market}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-right">
                      <span className="text-sm font-bold text-text-primary">${item.ratePerDay.toFixed(2)}</span>
                    </td>
                    <td className="py-4 px-4 text-center">
                      {item.yieldFloorApplied ? (
                        <span className="inline-flex items-center gap-1 text-warning text-xs">
                          <Shield className="w-3.5 h-3.5" />
                          Yes
                        </span>
                      ) : (
                        <span className="text-xs text-text-muted">No</span>
                      )}
                    </td>
                    <td className="py-4 px-4 text-right">
                      <span className="text-sm text-text-muted">{item.decisionTimeMs}ms</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* How it works */}
      <Card variant="glass" title="How A²E Routing Works">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
              <span className="text-accent font-bold">1</span>
            </div>
            <div>
              <h4 className="font-medium text-text-primary mb-1">Check Internal Demand</h4>
              <p className="text-sm text-text-muted">
                First, check if there are TokenOS agent tasks waiting. Internal jobs pay premium retail rates.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-xl bg-accent-blue/10 flex items-center justify-center flex-shrink-0">
              <span className="text-accent-blue font-bold">2</span>
            </div>
            <div>
              <h4 className="font-medium text-text-primary mb-1">Compare External Markets</h4>
              <p className="text-sm text-text-muted">
                If no internal demand, compare rates from Akash and IO.net to find the highest paying market.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-xl bg-accent-purple/10 flex items-center justify-center flex-shrink-0">
              <span className="text-accent-purple font-bold">3</span>
            </div>
            <div>
              <h4 className="font-medium text-text-primary mb-1">Apply Yield Floor</h4>
              <p className="text-sm text-text-muted">
                Ensure the final rate meets minimum thresholds. Boost if needed to maintain guaranteed yields.
              </p>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}

// Icons
function LabIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    </svg>
  )
}

function StarIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  )
}

function GlobeIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ClockIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function RouteIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
    </svg>
  )
}

function AlertIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}

function ShieldIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )
}

function CheckIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
