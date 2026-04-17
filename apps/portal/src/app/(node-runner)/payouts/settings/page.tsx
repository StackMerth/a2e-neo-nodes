'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowLeft, Save } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Profile {
  name: string
  email: string | null
  walletAddress: string
  payoutThreshold: number
  payoutFrequency: string
  payoutDayOfWeek: number | null
  payoutDayOfMonth: number | null
}

export default function PayoutSettingsPage() {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [wallet, setWallet] = useState('')
  const [threshold, setThreshold] = useState(10)
  const [frequency, setFrequency] = useState('WEEKLY')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const profile = await nodeRunner.profile() as Profile
        setName(profile.name)
        setEmail(profile.email ?? '')
        setWallet(profile.walletAddress)
        setThreshold(profile.payoutThreshold ?? 10)
        setFrequency(profile.payoutFrequency ?? 'WEEKLY')
        setDayOfWeek(profile.payoutDayOfWeek ?? 1)
        setDayOfMonth(profile.payoutDayOfMonth ?? 1)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await nodeRunner.settings({
        name: name || undefined,
        email: email || undefined,
        walletAddress: wallet || undefined,
        payoutThreshold: threshold,
        payoutFrequency: frequency,
        payoutDayOfWeek: frequency === 'WEEKLY' ? dayOfWeek : undefined,
        payoutDayOfMonth: frequency === 'MONTHLY' ? dayOfMonth : undefined,
      })
      toast('success', 'Settings saved')
    } catch (err) { toast('error', err instanceof Error ? err.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="animate-fadeIn"><div className="animate-shimmer h-64 rounded-xl" /></div>

  return (
    <motion.div
      className="space-y-6 max-w-2xl"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item}>
        <Link href="/payouts" className="text-sm inline-flex items-center gap-1 hover:opacity-80" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> Back to Payouts
        </Link>
        <h1 className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>Payout Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Manage your payout wallet and preferences</p>
      </motion.div>

      <form onSubmit={handleSave}>
        {/* Profile */}
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6 space-y-5 mb-6"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Profile</h2>
            <Input label="Display Name" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
            <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" />
            <Input label="Payout Wallet (Solana)" value={wallet} onChange={e => setWallet(e.target.value)} placeholder="Solana wallet address" />
          </div>
        </motion.div>

        {/* Payout Preferences */}
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6 space-y-5 mb-6"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Payout Preferences</h2>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Minimum Payout Threshold (USD)</label>
              <input
                type="number"
                min={1}
                max={100000}
                step={1}
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                className="w-full rounded-lg px-4 py-2.5 text-sm"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Payouts will only be triggered when your balance exceeds this amount</p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Payout Frequency</label>
              <div className="flex gap-2">
                {['DAILY', 'WEEKLY', 'MONTHLY'].map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFrequency(f)}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                    style={frequency === f
                      ? { background: 'var(--primary)', color: '#fff' }
                      : { background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }
                    }
                  >
                    {f.charAt(0) + f.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>

            {frequency === 'WEEKLY' && (
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Day of Week</label>
                <select
                  value={dayOfWeek}
                  onChange={e => setDayOfWeek(Number(e.target.value))}
                  className="w-full rounded-lg px-4 py-2.5 text-sm"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                >
                  {DAYS_OF_WEEK.map((day, i) => (
                    <option key={i} value={i}>{day}</option>
                  ))}
                </select>
              </div>
            )}

            {frequency === 'MONTHLY' && (
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Day of Month</label>
                <select
                  value={dayOfMonth}
                  onChange={e => setDayOfMonth(Number(e.target.value))}
                  className="w-full rounded-lg px-4 py-2.5 text-sm"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </motion.div>

        <motion.div variants={item}>
          <div className="flex justify-end">
            <Button type="submit" loading={saving}>
              <Save size={16} className="mr-2" />
              Save Changes
            </Button>
          </div>
        </motion.div>
      </form>
    </motion.div>
  )
}
