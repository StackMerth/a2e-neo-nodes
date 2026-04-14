'use client'

import { useState, useEffect } from 'react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface JobItem {
  id: string; status: string; market: string | null; earnings: number | null
  durationSeconds: number | null; createdAt: string; completedAt: string | null
  routingLog: { selectedMarket: string; selectedRate: number; reason: string } | null
}

interface JobsData { jobs: JobItem[]; total: number; page: number; limit: number; pages: number }

const STATUSES = ['', 'COMPLETED', 'FAILED', 'RUNNING', 'PENDING', 'CANCELLED'] as const

export default function JobsPage() {
  const [data, setData] = useState<JobsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')

  useEffect(() => { loadData() }, [page, status])

  async function loadData() {
    setLoading(true)
    try {
      const params: Record<string, string> = { page: String(page), limit: '20' }
      if (status) params.status = status
      setData(await nodeRunner.jobs(params) as JobsData)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const statusColors: Record<string, string> = {
    COMPLETED: 'bg-accent/10 text-accent', FAILED: 'bg-error/10 text-error',
    RUNNING: 'bg-accent-blue/10 text-accent-blue', PENDING: 'bg-surface-hover text-text-muted',
    ASSIGNED: 'bg-accent-purple/10 text-accent-purple', CANCELLED: 'bg-surface-hover text-text-muted',
    ROUTING: 'bg-warning/10 text-warning',
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Job History</h1>
        <p className="text-sm text-text-muted mt-1">All jobs executed on your nodes</p>
      </div>

      {/* Filter */}
      <div className="flex gap-1 flex-wrap">
        {STATUSES.map(s => (
          <button key={s} onClick={() => { setStatus(s); setPage(1) }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${status === s ? 'bg-accent text-white' : 'bg-surface border border-border text-text-muted hover:text-text-secondary'}`}>
            {s || 'All'}
          </button>
        ))}
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12" />)}</div>
        ) : !data || data.jobs.length === 0 ? (
          <div className="p-12 text-center text-text-muted text-sm">No jobs found</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-text-muted text-xs uppercase tracking-wider border-b border-border bg-surface-hover/50">
                  <th className="text-left px-5 py-3 font-medium">Job ID</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Market</th>
                  <th className="text-right px-5 py-3 font-medium">Duration</th>
                  <th className="text-right px-5 py-3 font-medium">Earnings</th>
                  <th className="text-right px-5 py-3 font-medium">Date</th>
                </tr></thead>
                <tbody>
                  {data.jobs.map(job => (
                    <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                      <td className="px-5 py-3 font-mono text-xs text-text-secondary">{job.id.slice(0, 12)}</td>
                      <td className="px-5 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[job.status] ?? ''}`}>{job.status}</span></td>
                      <td className="px-5 py-3 text-text-secondary">{job.market ?? '-'}</td>
                      <td className="px-5 py-3 text-right text-text-secondary">{job.durationSeconds != null ? `${Math.floor(job.durationSeconds / 60)}m ${job.durationSeconds % 60}s` : '-'}</td>
                      <td className="px-5 py-3 text-right text-text-primary font-medium">{job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-'}</td>
                      <td className="px-5 py-3 text-right text-text-muted text-xs">{new Date(job.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.pages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                <span className="text-xs text-text-muted">Page {data.page} of {data.pages} ({data.total} total)</span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
                  <Button variant="ghost" size="sm" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
