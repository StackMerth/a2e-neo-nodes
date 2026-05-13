'use client'

import { useState, useEffect } from 'react'
import { Copy, Check, Users, DollarSign, ExternalLink, Share2, UserPlus } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  MetricTriad,
  SectionCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'
import { A2ELoader } from '@/components/ui/A2ELoader'

interface ReferralEntry {
  id: string
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED'
  commissionAccrued: number
  createdAt: string
  expiresAt: string
  lastSettledAt: string | null
  referee: {
    name: string
    slug: string | null
    joinedAt: string
  }
}

interface ReferralResponse {
  referralCode: string
  shareUrl: string
  lifetimeCommission: number
  refereeCount: number
  activeReferees: number
  referrals: ReferralEntry[]
}

type ReferralRow = ReferralEntry & Record<string, unknown>

export default function ReferralPage() {
  const [data, setData] = useState<ReferralResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  useEffect(() => {
    nodeRunner.referral()
      .then(r => setData(r as ReferralResponse))
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false))
  }, [])

  function copy(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading referral data" />
  }

  if (!data) {
    return (
      <DashboardShell title="Referrals" subtitle="Refer operators, earn commission">
        <div className="lg:col-span-3">
          <SectionCard>
            <EmptyState
              icon={Users}
              title="Could not load referral data"
              description="Try refreshing the page or check back in a moment."
            />
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  const metrics: MetricCardData[] = [
    {
      label: 'Total referees',
      value: String(data.refereeCount),
      detail: `${data.activeReferees} active right now`,
      icon: Users,
      tone: 'green',
    },
    {
      label: 'Lifetime commission',
      value: `$${data.lifetimeCommission.toFixed(2)}`,
      detail: '10% of referee earnings',
      icon: DollarSign,
      tone: 'blue',
    },
    {
      label: 'Active windows',
      value: String(data.activeReferees),
      detail: 'Inside first 365 days',
      icon: UserPlus,
      tone: 'purple',
    },
  ]

  const columns: Array<DataTableColumn<ReferralRow>> = [
    {
      key: 'referee',
      header: 'Referee',
      render: (r) => (
        <div>
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{r.referee.name}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Joined {new Date(r.referee.joinedAt).toLocaleDateString()}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const styles: Record<string, { bg: string; color: string }> = {
          ACTIVE: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' },
          EXPIRED: { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' },
          REVOKED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)' },
        }
        const s = styles[r.status] ?? styles.EXPIRED!
        return (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ background: s.bg, color: s.color }}
          >
            {r.status}
          </span>
        )
      },
    },
    {
      key: 'commissionAccrued',
      header: 'Earned',
      align: 'right',
      mono: true,
      render: (r) => `$${r.commissionAccrued.toFixed(2)}`,
    },
    {
      key: 'expiresAt',
      header: 'Expires',
      align: 'right',
      render: (r) => new Date(r.expiresAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: '',
      align: 'right',
      render: (r) => r.referee.slug ? (
        <a
          href={`https://market.tokenos.ai/operator/${r.referee.slug}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs inline-flex items-center gap-1 hover:underline"
          style={{ color: 'var(--text-secondary)' }}
        >
          Profile <ExternalLink size={11} />
        </a>
      ) : null,
    },
  ]

  return (
    <DashboardShell
      title="Refer operators, earn commission"
      subtitle="10% of referee earnings for their first 365 days"
    >
      <div className="lg:col-span-3 flex flex-col gap-6">
        <MetricTriad metrics={metrics} />

        <SectionCard title="Quick share" icon={Share2}>
          <div className="space-y-5">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--text-muted)' }}>
                Your invite code
              </p>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-mono tracking-widest" style={{ color: 'var(--text-primary)' }}>
                  {data.referralCode}
                </span>
                <button
                  onClick={() => copy(data.referralCode, setCopiedCode)}
                  className="p-2 rounded transition-colors hover:bg-white/10"
                  aria-label="Copy code"
                >
                  {copiedCode
                    ? <Check size={16} style={{ color: 'var(--primary)' }} />
                    : <Copy size={16} style={{ color: 'var(--text-muted)' }} />}
                </button>
              </div>
            </div>

            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--text-muted)' }}>
                Share link
              </p>
              <div className="flex items-center gap-3">
                <code
                  className="flex-1 text-sm font-mono px-3 py-2 rounded truncate"
                  style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}
                >
                  {data.shareUrl}
                </code>
                <button
                  onClick={() => copy(data.shareUrl, setCopiedLink)}
                  className="p-2 rounded transition-colors hover:bg-white/10"
                  aria-label="Copy link"
                >
                  {copiedLink
                    ? <Check size={16} style={{ color: 'var(--primary)' }} />
                    : <Copy size={16} style={{ color: 'var(--text-muted)' }} />}
                </button>
              </div>
            </div>
          </div>
        </SectionCard>

        <DataTableCard<ReferralRow>
          title="Your referrals"
          icon={Users}
          columns={columns}
          rows={data.referrals as ReferralRow[]}
          loading={false}
          empty={
            <EmptyState
              icon={Users}
              title="No referrals yet"
              description="Share your code with an operator who is about to install the BYOG script. Their row appears here as soon as they finish onboarding."
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
