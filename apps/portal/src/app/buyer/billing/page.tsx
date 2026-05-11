'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { CreditCard, DollarSign, FileText, Download, Server, Clock, ExternalLink } from 'lucide-react'
import { buyer } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface BillingRequest {
  id: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  ratePerDay: number
  totalCost: number
  status: string
  txHash: string | null
  currency: string
  requestedAt: string
  activatedAt: string | null
  expiresAt: string | null
}

interface BillingData {
  totalSpent: number
  totalCo2Grams: number
  activeSubscriptions: number
  totalRequests: number
  currency: string
  months: Array<{
    month: string
    requests: BillingRequest[]
    total: number
    co2Grams: number
  }>
}

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  ACTIVE: { bg: 'rgba(34,197,94,0.15)', color: 'var(--success)' },
  COMPLETED: { bg: 'rgba(113,113,122,0.15)', color: 'var(--text-muted)' },
  PENDING: { bg: 'rgba(245,158,11,0.15)', color: 'var(--warning)' },
  APPROVED: { bg: 'rgba(59,130,246,0.15)', color: 'var(--info)' },
  ALLOCATED: { bg: 'rgba(139,92,246,0.15)', color: '#8b5cf6' },
  CANCELLED: { bg: 'rgba(113,113,122,0.15)', color: 'var(--text-muted)' },
  REJECTED: { bg: 'rgba(239,68,68,0.15)', color: 'var(--danger)' },
}

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        setData(await buyer.billing() as BillingData)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-64" />
      </div>
    )
  }

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          <CreditCard size={28} style={{ color: 'var(--primary)' }} />
          Billing
        </h1>
      </motion.div>

      {/* KPI Blocks */}
      <motion.div variants={item} className="stat-blocks">
        <div className="stat-block green">
          <div className="stat-icon"><DollarSign size={18} /></div>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>${(data?.totalSpent ?? 0).toFixed(2)}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Spent</div>
          </div>
        </div>
        <div className="stat-block blue">
          <div className="stat-icon"><Server size={18} /></div>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{data?.activeSubscriptions ?? 0}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Compute</div>
          </div>
        </div>
        <div className="stat-block purple">
          <div className="stat-icon"><FileText size={18} /></div>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{data?.totalRequests ?? 0}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Requests</div>
          </div>
        </div>
        {/* M5.8 / D3: lifetime CO2 across this buyer's rentals. */}
        <div className="stat-block" style={{ background: 'rgba(132, 204, 132, 0.08)' }}>
          <div className="stat-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v8" /><path d="M5 12h14" /><path d="M12 22a10 10 0 1 0-9.5-13" /></svg>
          </div>
          <div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {(() => {
                const g = data?.totalCo2Grams ?? 0
                return g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${g.toFixed(0)} g`
              })()}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CO2 emitted (est.)</div>
          </div>
        </div>
      </motion.div>

      {/* M5.8 / D3: methodology footnote. Auditing the math is the
          difference between honest reporting and PR fluff. */}
      <motion.div variants={item}>
        <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          CO2 estimate: (GPU TDP watts × count × minutes / 60 / 1000) × region grid intensity (g CO2/kWh).
          H100/H200 700W, B200 1000W, B300 1200W, GB300 1400W. Grid intensity by region: US-WEST 290, US-EAST 380, EU 250, APAC 540, SA 140, OC 530, unknown 400. Honest approximation, never a paid offset claim.
        </p>
      </motion.div>

      {/* Monthly Breakdown */}
      {(data?.months ?? []).length === 0 ? (
        <motion.div variants={item}>
          <div className="text-center py-16 rounded-xl" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <CreditCard size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No billing history yet</p>
            <Link href="/buyer/request" className="text-sm mt-2 inline-block" style={{ color: 'var(--primary)' }}>Request Compute</Link>
          </div>
        </motion.div>
      ) : (
        (data?.months ?? []).map((month) => (
          <motion.div key={month.month} variants={item}>
            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
              <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <div className="flex items-center gap-2">
                  <Clock size={14} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{month.month}</span>
                </div>
                <span className="text-sm font-bold" style={{ color: 'var(--primary)' }}>${month.total.toFixed(2)}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--glass-border)', color: 'var(--text-muted)' }}>
                      <th className="text-left px-5 py-2 text-xs uppercase tracking-wider font-medium">GPU</th>
                      <th className="text-left px-5 py-2 text-xs uppercase tracking-wider font-medium">Duration</th>
                      <th className="text-left px-5 py-2 text-xs uppercase tracking-wider font-medium">Status</th>
                      <th className="text-right px-5 py-2 text-xs uppercase tracking-wider font-medium">Cost</th>
                      <th className="text-right px-5 py-2 text-xs uppercase tracking-wider font-medium">Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {month.requests.map((req) => {
                      const ss = STATUS_STYLES[req.status] ?? STATUS_STYLES.PENDING!
                      return (
                        <tr key={req.id} className="hover:opacity-90 transition-colors" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                          <td className="px-5 py-3">
                            <Link href={`/buyer/requests/${req.id}`} className="hover:underline" style={{ color: 'var(--text-primary)' }}>
                              {req.gpuCount}x {req.gpuTier}
                            </Link>
                          </td>
                          <td className="px-5 py-3" style={{ color: 'var(--text-secondary)' }}>{req.durationDays} days</td>
                          <td className="px-5 py-3">
                            <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: ss.bg, color: ss.color }}>{req.status}</span>
                          </td>
                          <td className="px-5 py-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>${req.totalCost.toFixed(2)}</td>
                          <td className="px-5 py-3 text-right">
                            {['ACTIVE', 'COMPLETED', 'APPROVED', 'ALLOCATED'].includes(req.status) ? (
                              <a
                                href={buyer.invoiceUrl(req.id)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs hover:underline"
                                style={{ color: 'var(--primary)' }}
                              >
                                <Download size={12} /> Invoice
                              </a>
                            ) : (
                              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        ))
      )}
    </motion.div>
  )
}
