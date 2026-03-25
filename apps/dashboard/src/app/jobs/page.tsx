'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Input'
import { api } from '@/lib/api'

interface Job {
  id: string
  deploymentId: string
  gpuTier: string
  status: string
  market: string | null
  ratePerHour: number | null
  requestedAt: string
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ROUTING', label: 'Routing' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
]

const MARKET_OPTIONS = [
  { value: '', label: 'All Markets' },
  { value: 'INTERNAL', label: 'Internal' },
  { value: 'AKASH', label: 'Akash' },
  { value: 'IONET', label: 'IO.net' },
]

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [marketFilter, setMarketFilter] = useState('')

  const loadJobs = useCallback(async () => {
    try {
      const params: { limit: number; status?: string; market?: string } = { limit: 50 }
      if (statusFilter) params.status = statusFilter
      if (marketFilter) params.market = marketFilter
      const data = await api.jobs.list(params)
      setJobs(data.jobs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, marketFilter])

  useEffect(() => {
    loadJobs()
    const interval = setInterval(loadJobs, 5000)
    return () => clearInterval(interval)
  }, [loadJobs])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'bg-accent text-accent'
      case 'RUNNING': return 'bg-blue-500 text-blue-400'
      case 'ASSIGNED': return 'bg-purple-500 text-purple-400'
      case 'PENDING': return 'bg-warning text-warning'
      case 'FAILED': return 'bg-error text-error'
      default: return 'bg-text-muted text-text-muted'
    }
  }

  const getMarketColor = (market: string | null) => {
    switch (market) {
      case 'INTERNAL': return 'bg-accent/10 text-accent'
      case 'AKASH': return 'bg-blue-500/10 text-blue-400'
      case 'IONET': return 'bg-purple-500/10 text-purple-400'
      default: return 'bg-surface text-text-muted'
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Jobs</h1>
          <p className="text-text-muted mt-1">
            View routing decisions and job status
          </p>
        </div>
        <Button onClick={loadJobs} variant="secondary" size="sm">
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="w-40">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={STATUS_OPTIONS}
          />
        </div>
        <div className="w-40">
          <Select
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
            options={MARKET_OPTIONS}
          />
        </div>
        {(statusFilter || marketFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStatusFilter(''); setMarketFilter('') }}
          >
            Clear Filters
          </Button>
        )}
        <span className="text-sm text-text-muted ml-auto">
          {jobs.length} job{jobs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      <Card>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-text-muted">Loading...</p>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-text-muted">No jobs yet. <a href="/routing" className="text-accent hover:underline">Test routing</a> to create one.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Deployment</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">GPU</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Market</th>
                  <th className="text-left py-3 px-4 text-xs text-text-muted uppercase">Status</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Rate</th>
                  <th className="text-right py-3 px-4 text-xs text-text-muted uppercase">Requested</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover">
                    <td className="py-3 px-4">
                      <Link href={`/jobs/${job.id}`} className="text-sm text-accent hover:underline font-medium">
                        {job.deploymentId}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-1 bg-accent/10 text-accent text-xs rounded">
                        {job.gpuTier}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getMarketColor(job.market)}`}>
                        {job.market || 'PENDING'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${getStatusColor(job.status).split(' ')[0]}`} />
                        <span className="text-sm text-text-secondary">{job.status}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-primary">
                      {job.ratePerHour ? `$${(job.ratePerHour * 24).toFixed(2)}/day` : '-'}
                    </td>
                    <td className="py-3 px-4 text-right text-sm text-text-muted">
                      {new Date(job.requestedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
