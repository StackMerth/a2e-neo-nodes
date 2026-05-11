'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Copy, Check, Users, DollarSign, ExternalLink } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'

interface ReferralResponse {
  referralCode: string
  shareUrl: string
  lifetimeCommission: number
  refereeCount: number
  activeReferees: number
  referrals: Array<{
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
  }>
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!data) {
    return (
      <Card className="p-8 text-center">
        <p style={{ color: 'var(--text-muted)' }}>Could not load referral data.</p>
      </Card>
    )
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      <motion.div variants={item}>
        <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
          Refer operators, earn commission
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Share your invite code. When a new operator signs up with it, you earn 10% of their network earnings for their first 365 days. The math is public and auditable on every referral row below.
        </p>
      </motion.div>

      {/* Code + share */}
      <motion.div variants={item}>
        <Card className="p-6">
          <p className="text-xs uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
            Your invite code
          </p>
          <div className="flex items-center gap-3 mb-6">
            <span className="text-3xl font-mono tracking-widest" style={{ color: 'var(--text-primary)' }}>
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

          <p className="text-xs uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
            Share link
          </p>
          <div className="flex items-center gap-3">
            <code
              className="flex-1 text-sm font-mono px-3 py-2 rounded truncate"
              style={{ background: 'var(--surface-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
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
        </Card>
      </motion.div>

      {/* Stats */}
      <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat icon={<DollarSign size={16} />} label="Lifetime commission" value={`$${data.lifetimeCommission.toFixed(2)}`} sub="10% of referee earnings" />
        <Stat icon={<Users size={16} />} label="Total referees" value={String(data.refereeCount)} sub={`${data.activeReferees} active right now`} />
        <Stat icon={<Users size={16} />} label="Active windows" value={String(data.activeReferees)} sub="Inside first 365 days" />
      </motion.div>

      {/* Referrals list */}
      <motion.div variants={item}>
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
            Your referrals
          </h2>
          {data.referrals.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No referrals yet. Share your code with an operator who is about to install the BYOG script and your row appears here as soon as they finish onboarding.
            </p>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {data.referrals.map(r => (
                <li key={r.id} className="py-4 grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-12 md:col-span-5">
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{r.referee.name}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      Joined {new Date(r.referee.joinedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="col-span-6 md:col-span-3">
                    <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Status</p>
                    <p className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{r.status}</p>
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Earned</p>
                    <p className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>${r.commissionAccrued.toFixed(2)}</p>
                  </div>
                  <div className="col-span-12 md:col-span-2 md:text-right">
                    {r.referee.slug && (
                      <a
                        href={`https://marketplace.stackforgelab.tech/operator/${r.referee.slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs inline-flex items-center gap-1 hover:underline"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        View profile <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </motion.div>
    </motion.div>
  )
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--text-muted)' }}>
        {icon}
        <span className="text-xs uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{sub}</p>
    </Card>
  )
}
