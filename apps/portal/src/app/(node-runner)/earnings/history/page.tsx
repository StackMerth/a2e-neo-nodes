'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Download } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface EarningRow {
  id: string; nodeId: string; date: string; market: string; earnings: number; gpuSeconds: number; jobCount: number
}

interface HistoryData {
  earnings: EarningRow[]; total: number; page: number; limit: number; pages: number
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function EarningsHistoryPage() {
  const [data, setData] = useState<HistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  useEffect(() => { loadData() }, [page])

  async function loadData() {
    setLoading(true)
    try {
      const d = await nodeRunner.earningsHistory({ page: String(page), limit: '30' }) as HistoryData
      setData(d)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  function exportCSV() {
    if (!data || data.earnings.length === 0) return
    const headers = ['Date', 'Node ID', 'Market', 'Jobs', 'GPU Seconds', 'Earnings (USD)']
    const rows = data.earnings.map(r => [
      new Date(r.date).toLocaleDateString(),
      r.nodeId,
      r.market,
      r.jobCount,
      r.gpuSeconds,
      r.earnings.toFixed(4),
    ])
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `a2e-earnings-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <Link href="/earnings" className="text-sm hover:opacity-80" style={{ color: 'var(--text-muted)' }}>&larr; Back to Earnings</Link>
          <h1 className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>Earnings History</h1>
        </div>
        <Button variant="secondary" size="sm" onClick={exportCSV} disabled={!data || data.earnings.length === 0}>
          <Download size={16} className="mr-2" />
          Export CSV
        </Button>
      </motion.div>

      <motion.div variants={item}>
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          {loading ? (
            <div className="p-6 space-y-3">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10" />)}</div>
          ) : !data || data.earnings.length === 0 ? (
            <div className="p-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No earnings records found</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="text-xs uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)' }}
                    >
                      <th className="text-left px-5 py-3 font-medium">Date</th>
                      <th className="text-left px-5 py-3 font-medium">Market</th>
                      <th className="text-right px-5 py-3 font-medium">Jobs</th>
                      <th className="text-right px-5 py-3 font-medium">GPU Time</th>
                      <th className="text-right px-5 py-3 font-medium">Earnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.earnings.map(row => (
                      <tr key={row.id} className="transition-colors hover:opacity-90" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                        <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{new Date(row.date).toLocaleDateString()}</td>
                        <td className="px-5 py-3"><MarketBadge market={row.market} /></td>
                        <td className="px-5 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>{row.jobCount}</td>
                        <td className="px-5 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>{(row.gpuSeconds / 3600).toFixed(1)}h</td>
                        <td className="px-5 py-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>${row.earnings.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.pages > 1 && (
                <div
                  className="flex items-center justify-between px-5 py-3"
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {data.page} of {data.pages} ({data.total} records)</span>
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

function MarketBadge({ market }: { market: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    INTERNAL: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' },
    AKASH: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)' },
    IONET: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' },
  }
  const s = styles[market] ?? { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
  return (
    <span
      className="text-xs font-medium px-2 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}
    >
      {market}
    </span>
  )
}
