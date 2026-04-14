'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface Payout {
  id: string; nodeId: string; walletAddress: string; amount: number; currency: string
  status: string; periodStart: string; periodEnd: string; jobCount: number
  txHash: string | null; txConfirmed: boolean; createdAt: string; processedAt: string | null
}

interface PayoutData { payouts: Payout[]; total: number; page: number; limit: number; pages: number }

export default function PayoutsPage() {
  const [data, setData] = useState<PayoutData | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  useEffect(() => { loadData() }, [page])

  async function loadData() {
    setLoading(true)
    try { setData(await nodeRunner.payouts({ page: String(page), limit: '20' }) as PayoutData) }
    catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const statusColors: Record<string, string> = {
    COMPLETED: 'bg-accent/10 text-accent', PENDING: 'bg-warning/10 text-warning',
    PROCESSING: 'bg-accent-blue/10 text-accent-blue', FAILED: 'bg-error/10 text-error',
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Payouts</h1>
          <p className="text-sm text-text-muted mt-1">Settlement and payment history</p>
        </div>
        <Link href="/payouts/settings"><Button variant="secondary" size="sm">Payout Settings</Button></Link>
      </div>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}</div>
        ) : !data || data.payouts.length === 0 ? (
          <div className="p-12 text-center text-text-muted text-sm">No payouts yet</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-text-muted text-xs uppercase tracking-wider border-b border-border bg-surface-hover/50">
                  <th className="text-left px-5 py-3 font-medium">Date</th>
                  <th className="text-left px-5 py-3 font-medium">Period</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-right px-5 py-3 font-medium">Jobs</th>
                  <th className="text-right px-5 py-3 font-medium">Amount</th>
                  <th className="text-right px-5 py-3 font-medium">TX</th>
                </tr></thead>
                <tbody>
                  {data.payouts.map(p => (
                    <tr key={p.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                      <td className="px-5 py-3 text-text-primary">{new Date(p.createdAt).toLocaleDateString()}</td>
                      <td className="px-5 py-3 text-text-secondary text-xs">{new Date(p.periodStart).toLocaleDateString()} - {new Date(p.periodEnd).toLocaleDateString()}</td>
                      <td className="px-5 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[p.status] ?? ''}`}>{p.status}</span></td>
                      <td className="px-5 py-3 text-right text-text-secondary">{p.jobCount}</td>
                      <td className="px-5 py-3 text-right text-text-primary font-semibold">${p.amount.toFixed(2)}</td>
                      <td className="px-5 py-3 text-right">
                        {p.txHash ? (
                          <a href={`https://solscan.io/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline font-mono">
                            {p.txHash.slice(0, 8)}...
                          </a>
                        ) : <span className="text-xs text-text-muted">-</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.pages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                <span className="text-xs text-text-muted">Page {data.page} of {data.pages}</span>
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
