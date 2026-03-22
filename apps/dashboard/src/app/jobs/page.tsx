'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
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

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadJobs()
    const interval = setInterval(loadJobs, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadJobs() {
    try {
      const data = await api.jobs.list({ limit: 50 })
      setJobs(data.jobs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }

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
                    <td className="py-3 px-4 text-sm text-text-primary font-medium">{job.deploymentId}</td>
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
