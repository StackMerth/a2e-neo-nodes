'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
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
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/earnings" className="text-sm text-text-muted hover:text-text-secondary">&larr; Back to Earnings</Link>
          <h1 className="text-2xl font-bold text-text-primary mt-1">Earnings History</h1>
        </div>
        <Button variant="secondary" size="sm" onClick={exportCSV} disabled={!data || data.earnings.length === 0}>
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
          Export CSV
        </Button>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-10" />)}</div>
        ) : !data || data.earnings.length === 0 ? (
          <div className="p-12 text-center text-text-muted text-sm">No earnings records found</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-text-muted text-xs uppercase tracking-wider border-b border-border bg-surface-hover/50">
                  <th className="text-left px-5 py-3 font-medium">Date</th>
                  <th className="text-left px-5 py-3 font-medium">Market</th>
                  <th className="text-right px-5 py-3 font-medium">Jobs</th>
                  <th className="text-right px-5 py-3 font-medium">GPU Time</th>
                  <th className="text-right px-5 py-3 font-medium">Earnings</th>
                </tr></thead>
                <tbody>
                  {data.earnings.map(row => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                      <td className="px-5 py-3 text-text-primary">{new Date(row.date).toLocaleDateString()}</td>
                      <td className="px-5 py-3"><MarketBadge market={row.market} /></td>
                      <td className="px-5 py-3 text-right text-text-secondary">{row.jobCount}</td>
                      <td className="px-5 py-3 text-right text-text-secondary">{(row.gpuSeconds / 3600).toFixed(1)}h</td>
                      <td className="px-5 py-3 text-right text-text-primary font-medium">${row.earnings.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.pages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                <span className="text-xs text-text-muted">Page {data.page} of {data.pages} ({data.total} records)</span>
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

function MarketBadge({ market }: { market: string }) {
  const colors: Record<string, string> = { INTERNAL: 'bg-accent/10 text-accent', AKASH: 'bg-accent-blue/10 text-accent-blue', IONET: 'bg-accent-purple/10 text-accent-purple' }
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${colors[market] ?? 'bg-surface-hover text-text-muted'}`}>{market}</span>
}
