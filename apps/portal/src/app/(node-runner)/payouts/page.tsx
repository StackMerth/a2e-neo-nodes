'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Wallet, ExternalLink, CircleCheck, Clock, Loader2, CircleX } from 'lucide-react'
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

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const statusConfig: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
  COMPLETED: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', icon: <CircleCheck size={12} /> },
  PENDING: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: <Clock size={12} /> },
  PROCESSING: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', icon: <Loader2 size={12} className="animate-spin" /> },
  FAILED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: <CircleX size={12} /> },
}

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

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Payouts</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Settlement and payment history</p>
        </div>
        <Link href="/payouts/settings"><Button variant="secondary" size="sm"><Wallet size={16} className="mr-2" />Payout Settings</Button></Link>
      </motion.div>

      <motion.div variants={item}>
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          {loading ? (
            <div className="p-6 space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : !data || data.payouts.length === 0 ? (
            <div className="p-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No payouts yet</div>
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
                      <th className="text-left px-5 py-3 font-medium">Period</th>
                      <th className="text-left px-5 py-3 font-medium">Status</th>
                      <th className="text-right px-5 py-3 font-medium">Jobs</th>
                      <th className="text-right px-5 py-3 font-medium">Amount</th>
                      <th className="text-right px-5 py-3 font-medium">TX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payouts.map(p => {
                      const sc = statusConfig[p.status] ?? statusConfig.PENDING!
                      return (
                        <tr key={p.id} className="transition-colors hover:opacity-90" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                          <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>{new Date(p.createdAt).toLocaleDateString()}</td>
                          <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{new Date(p.periodStart).toLocaleDateString()} - {new Date(p.periodEnd).toLocaleDateString()}</td>
                          <td className="px-5 py-3">
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                              style={{ background: sc.bg, color: sc.color }}
                            >
                              {sc.icon}
                              {p.status}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>{p.jobCount}</td>
                          <td className="px-5 py-3 text-right font-semibold" style={{ color: 'var(--text-primary)' }}>${p.amount.toFixed(2)}</td>
                          <td className="px-5 py-3 text-right">
                            {p.txHash ? (
                              <a
                                href={`https://solscan.io/tx/${p.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-mono inline-flex items-center gap-1 hover:opacity-80"
                                style={{ color: 'var(--primary)' }}
                              >
                                {p.txHash.slice(0, 8)}...
                                <ExternalLink size={10} />
                              </a>
                            ) : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>}
                          </td>
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
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Page {data.page} of {data.pages}</span>
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
