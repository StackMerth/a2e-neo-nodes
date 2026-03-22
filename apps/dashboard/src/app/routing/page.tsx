'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'

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
      // Generate new deployment ID for next test
      setDeploymentId('#' + Math.floor(100 + Math.random() * 900))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Routing request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Test Routing</h1>
        <p className="text-text-muted mt-1">
          Test the A²E routing engine with different configurations
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Request Form */}
        <Card title="Routing Request" description="Configure and send a POST /v1/route request">
          <form onSubmit={handleSubmit} className="space-y-6 mt-4">
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

            <div className="space-y-2">
              <label className="block text-sm font-medium text-text-secondary">
                Internal Demand
              </label>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={!hasInternalDemand}
                    onChange={() => setHasInternalDemand(false)}
                    className="w-4 h-4 accent-accent"
                  />
                  <span className="text-text-primary">No (Route to external)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={hasInternalDemand}
                    onChange={() => setHasInternalDemand(true)}
                    className="w-4 h-4 accent-accent"
                  />
                  <span className="text-text-primary">Yes (Premium rate)</span>
                </label>
              </div>
              <p className="text-xs text-text-muted">
                When internal demand exists, jobs route to INTERNAL at premium retail rate
              </p>
            </div>

            {error && (
              <div className="p-4 bg-error/10 border border-error/20 rounded-lg">
                <p className="text-error text-sm">{error}</p>
              </div>
            )}

            <Button type="submit" loading={loading} className="w-full">
              Send Routing Request
            </Button>
          </form>
        </Card>

        {/* Result Display */}
        <Card title="Routing Decision" description="Response from POST /v1/route">
          {result ? (
            <div className="space-y-4 mt-4">
              {/* Market Badge */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">Selected Market</span>
                <span className={`px-4 py-2 rounded-lg font-bold text-lg ${
                  result.market === 'INTERNAL'
                    ? 'bg-accent/10 text-accent border border-accent/20'
                    : result.market === 'AKASH'
                    ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                    : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                }`}>
                  {result.market}
                </span>
              </div>

              {/* Rate */}
              <div className="p-4 bg-background rounded-lg">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-text-muted">Rate</span>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-accent">${result.ratePerDay.toFixed(2)}<span className="text-sm text-text-muted">/day</span></p>
                    <p className="text-sm text-text-muted">${result.ratePerHour.toFixed(4)}/hr</p>
                  </div>
                </div>
              </div>

              {/* Reason */}
              <div className="p-4 bg-background rounded-lg">
                <p className="text-sm text-text-muted mb-1">Reason</p>
                <p className="text-text-primary">{result.reason}</p>
              </div>

              {/* Meta Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-background rounded-lg">
                  <p className="text-xs text-text-muted">Yield Floor Applied</p>
                  <p className={`font-semibold ${result.yieldFloorApplied ? 'text-warning' : 'text-accent'}`}>
                    {result.yieldFloorApplied ? 'Yes' : 'No'}
                  </p>
                </div>
                <div className="p-3 bg-background rounded-lg">
                  <p className="text-xs text-text-muted">Decision Time</p>
                  <p className="font-semibold text-text-primary">{result.decisionTimeMs}ms</p>
                </div>
              </div>

              {/* Job ID */}
              <div className="p-3 bg-background rounded-lg">
                <p className="text-xs text-text-muted">Job ID</p>
                <p className="font-mono text-sm text-text-secondary break-all">{result.jobId}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-text-muted">
              <p>Send a request to see the routing decision</p>
            </div>
          )}
        </Card>
      </div>

      {/* History */}
      {history.length > 0 && (
        <Card title="Recent Routing Decisions">
          <div className="overflow-x-auto mt-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Deployment</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Market</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Rate/Day</th>
                  <th className="text-center py-3 px-4 text-xs text-text-muted uppercase">Floor</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, i) => (
                  <tr key={item.jobId} className={`border-b border-border/50 ${i === 0 ? 'bg-accent/5' : ''}`}>
                    <td className="py-3 px-4 text-sm text-text-primary">{item.deploymentId}</td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        item.market === 'INTERNAL' ? 'bg-accent/10 text-accent' :
                        item.market === 'AKASH' ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400'
                      }`}>
                        {item.market}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-primary">${item.ratePerDay.toFixed(2)}</td>
                    <td className="py-3 px-4 text-center">
                      <span className={`text-xs ${item.yieldFloorApplied ? 'text-warning' : 'text-text-muted'}`}>
                        {item.yieldFloorApplied ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-muted">{item.decisionTimeMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
