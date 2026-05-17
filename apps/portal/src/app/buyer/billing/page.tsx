'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { CreditCard, DollarSign, FileText, Download, Server, Leaf, TrendingUp } from 'lucide-react'
import { buyer } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  SectionCard,
  MetricTriad,
  EmptyState,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

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

  // Compute KPIs: this-month spend, lifetime spend, average $/hr across rentals.
  const thisMonth = data?.months?.[0]
  const thisMonthSpend = thisMonth?.total ?? 0
  const lifetimeSpend = data?.totalSpent ?? 0
  // Average $/hr across all rentals: sum(totalCost) / sum(durationDays * 24)
  let totalHours = 0
  let totalDollars = 0
  for (const m of data?.months ?? []) {
    for (const r of m.requests) {
      totalHours += r.durationDays * 24
      totalDollars += r.totalCost
    }
  }
  const avgRate = totalHours > 0 ? totalDollars / totalHours : 0

  const co2Display = (() => {
    const g = data?.totalCo2Grams ?? 0
    return g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${g.toFixed(0)} g`
  })()

  const metrics: MetricCardData[] = [
    {
      label: 'This Month',
      value: `$${thisMonthSpend.toFixed(2)}`,
      detail: thisMonth?.month ?? 'No spend yet',
      icon: DollarSign,
      tone: 'green',
    },
    {
      label: 'Lifetime Spend',
      value: `$${lifetimeSpend.toFixed(2)}`,
      detail: `${data?.totalRequests ?? 0} rentals total`,
      icon: TrendingUp,
      tone: 'blue',
    },
    {
      label: 'Average $/hr',
      value: `$${avgRate.toFixed(2)}`,
      detail: `${data?.activeSubscriptions ?? 0} active &middot; ${co2Display} CO2`,
      icon: Server,
      tone: 'purple',
    },
  ]

  return (
    <DashboardShell
      title="Billing"
      subtitle="Compute spend and invoices"
    >
      <DashboardMainColumn>
        <MetricTriad metrics={metrics} />

        {/* CO2 methodology footnote — readable provenance for the sustainability stat. */}
        <SectionCard title="Carbon estimate" icon={Leaf}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            CO2 estimate: (GPU TDP watts &times; count &times; minutes / 60 / 1000) &times; region grid intensity (g CO2/kWh).
            H100/H200 700W, B200 1000W, B300 1200W, GB300 1400W. Grid intensity by region: US-WEST 290, US-EAST 380, EU 250, APAC 540, SA 140, OC 530, unknown 400. Honest approximation, never a paid offset claim.
          </p>
        </SectionCard>

        {/* Per-month rental tables — keep the per-month grouping. */}
        {loading ? (
          <SectionCard title="Loading">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading billing data...</p>
          </SectionCard>
        ) : (data?.months ?? []).length === 0 ? (
          <SectionCard>
            <EmptyState
              icon={CreditCard}
              title="No billing history yet"
              description="Your rentals and invoices will appear here once you submit a compute request."
              action={
                <Link
                  href="/buyer/request"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium"
                  style={{ background: 'var(--primary)', color: '#fff' }}
                >
                  Request Compute
                </Link>
              }
            />
          </SectionCard>
        ) : (
          (data?.months ?? []).map((month) => (
            <SectionCard
              key={month.month}
              title={month.month}
              icon={FileText}
              actions={
                <span className="text-sm font-bold" style={{ color: 'var(--primary)' }}>
                  ${month.total.toFixed(2)}
                </span>
              }
              noPadding
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-border-subtle" style={{ background: 'rgba(255, 255, 255, 0.02)' }}>
                      <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>GPU</th>
                      <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Duration</th>
                      <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>Status</th>
                      <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-right" style={{ color: 'var(--text-muted)' }}>Cost</th>
                      <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-right" style={{ color: 'var(--text-muted)' }}>Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {month.requests.map((req) => {
                      const ss = STATUS_STYLES[req.status] ?? STATUS_STYLES.PENDING!
                      return (
                        <tr key={req.id} className="border-b border-border-subtle transition-colors hover:bg-surface-hover">
                          <td className="px-5 py-3">
                            <Link href={`/buyer/requests/${req.id}`} className="hover:underline" style={{ color: 'var(--text-primary)' }}>
                              {req.gpuCount}x {req.gpuTier}
                            </Link>
                          </td>
                          <td className="px-5 py-3" style={{ color: 'var(--text-secondary)' }}>{req.durationDays} days</td>
                          <td className="px-5 py-3">
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full"
                              style={{ background: ss.bg, color: ss.color }}
                            >
                              {req.status}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right font-mono text-xs" style={{ color: 'var(--text-primary)' }}>
                            ${req.totalCost.toFixed(2)}
                          </td>
                          <td className="px-5 py-3 text-right">
                            {['ACTIVE', 'COMPLETED', 'APPROVED', 'ALLOCATED'].includes(req.status) ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  try { await buyer.downloadInvoice(req.id) }
                                  catch (e) { window.alert(e instanceof Error ? e.message : 'Invoice fetch failed') }
                                }}
                                className="inline-flex items-center gap-1 text-xs hover:underline"
                                style={{ color: 'var(--primary)' }}
                              >
                                <Download size={12} /> Invoice
                              </button>
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
            </SectionCard>
          ))
        )}
      </DashboardMainColumn>
    </DashboardShell>
  )
}
