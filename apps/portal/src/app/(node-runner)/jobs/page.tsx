'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { CircleCheck, CircleX, Loader2, Clock, Ban, Zap, Route } from 'lucide-react'
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

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const statusIcons: Record<string, React.ReactNode> = {
  COMPLETED: <CircleCheck size={12} />,
  FAILED: <CircleX size={12} />,
  RUNNING: <Loader2 size={12} className="animate-spin" />,
  PENDING: <Clock size={12} />,
  ASSIGNED: <Zap size={12} />,
  CANCELLED: <Ban size={12} />,
  ROUTING: <Route size={12} />,
}

const statusStyles: Record<string, { bg: string; color: string }> = {
  COMPLETED: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' },
  FAILED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)' },
  RUNNING: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' },
  PENDING: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' },
  ASSIGNED: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' },
  CANCELLED: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' },
  ROUTING: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)' },
}

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

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item}>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Job History</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>All jobs executed on your nodes</p>
      </motion.div>

      {/* Filter */}
      <motion.div variants={item} className="flex gap-1 flex-wrap">
        {STATUSES.map(s => {
          const isActive = status === s
          return (
            <button
              key={s}
              onClick={() => { setStatus(s); setPage(1) }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={isActive
                ? { background: 'var(--primary)', color: '#fff' }
                : { background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }
              }
            >
              {s || 'All'}
            </button>
          )
        })}
      </motion.div>

      <motion.div variants={item}>
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          {loading ? (
            <div className="p-6 space-y-3">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : !data || data.jobs.length === 0 ? (
            <div className="p-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No jobs found</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="text-xs uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)' }}
                    >
                      <th className="text-left px-5 py-3 font-medium">Job ID</th>
                      <th className="text-left px-5 py-3 font-medium">Status</th>
                      <th className="text-left px-5 py-3 font-medium">Market</th>
                      <th className="text-right px-5 py-3 font-medium">Duration</th>
                      <th className="text-right px-5 py-3 font-medium">Earnings</th>
                      <th className="text-right px-5 py-3 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.map(job => {
                      const ss = statusStyles[job.status] ?? statusStyles.PENDING!
                      return (
                        <tr key={job.id} className="transition-colors hover:opacity-90" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                          <td className="px-5 py-3 font-mono text-xs"><Link href={`/jobs/${job.id}`} className="hover:underline" style={{ color: 'var(--primary)' }}>{job.id.slice(0, 12)}</Link></td>
                          <td className="px-5 py-3">
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                              style={{ background: ss.bg, color: ss.color }}
                            >
                              {statusIcons[job.status] ?? <Clock size={12} />}
                              {job.status}
                            </span>
                          </td>
                          <td className="px-5 py-3" style={{ color: 'var(--text-secondary)' }}>{job.market ?? '-'}</td>
                          <td className="px-5 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>{job.durationSeconds != null ? `${Math.floor(job.durationSeconds / 60)}m ${job.durationSeconds % 60}s` : '-'}</td>
                          <td className="px-5 py-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{job.earnings != null ? `$${job.earnings.toFixed(4)}` : '-'}</td>
                          <td className="px-5 py-3 text-right text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(job.createdAt).toLocaleDateString()}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {data.pages > 1 && (
                <div
                  className="flex items-center justify-between px-5 py-3"
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {data.page} of {data.pages} ({data.total} total)</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
                    <Button variant="ghost" size="sm" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
