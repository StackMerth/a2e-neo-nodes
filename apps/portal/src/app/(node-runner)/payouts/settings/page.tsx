'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, Save, User, Wallet, CalendarClock } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { A2ELoader } from '@/components/ui/A2ELoader'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

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

  if (loading) {
    return <A2ELoader fullScreen={false} message="Loading payout settings" />
  }

  return (
    <DashboardShell
      title="Payout Settings"
      subtitle="Manage your payout wallet and preferences"
    >
      <div className="lg:col-span-3 max-w-3xl mx-auto w-full space-y-6">
        <Link
          href="/payouts"
          className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.18em] hover:opacity-80 w-fit"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={12} /> Back to Payouts
        </Link>

        <form onSubmit={handleSave} className="space-y-6">
          <FormCard
            title="Profile"
            description="Display identity attached to this operator account"
            icon={User}
          >
            <FormSection>
              <Input label="Display Name" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
              <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" />
            </FormSection>
          </FormCard>

          <FormCard
            title="Payout Wallet"
            description="Solana wallet that receives settlements and referral commission"
            icon={Wallet}
          >
            <FormSection>
              <Input
                label="Payout Wallet (Solana)"
                value={wallet}
                onChange={e => setWallet(e.target.value)}
                placeholder="Solana wallet address"
              />
            </FormSection>
          </FormCard>

          <FormCard
            title="Payout Preferences"
            description="How often and at what threshold should settlements run"
            icon={CalendarClock}
          >
            <FormSection title="Threshold">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Minimum Payout Threshold (USD)
                </label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  value={threshold}
                  onChange={e => setThreshold(Number(e.target.value))}
                  className="w-full rounded-md px-4 py-2.5 text-sm"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                />
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Payouts will only be triggered when your balance exceeds this amount.
                </p>
              </div>
            </FormSection>

            <FormSection title="Frequency">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Payout Frequency
                </label>
                <div className="flex gap-2">
                  {['DAILY', 'WEEKLY', 'MONTHLY'].map(f => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFrequency(f)}
                      className="px-4 py-2 rounded-md text-sm font-medium transition-all"
                      style={frequency === f
                        ? { background: 'var(--primary)', color: '#fff' }
                        : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }
                      }
                    >
                      {f.charAt(0) + f.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>

              {frequency === 'WEEKLY' && (
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Day of Week
                  </label>
                  <select
                    value={dayOfWeek}
                    onChange={e => setDayOfWeek(Number(e.target.value))}
                    className="w-full rounded-md px-4 py-2.5 text-sm"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    {DAYS_OF_WEEK.map((day, i) => (
                      <option key={i} value={i}>{day}</option>
                    ))}
                  </select>
                </div>
              )}

              {frequency === 'MONTHLY' && (
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Day of Month
                  </label>
                  <select
                    value={dayOfMonth}
                    onChange={e => setDayOfMonth(Number(e.target.value))}
                    className="w-full rounded-md px-4 py-2.5 text-sm"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              )}
            </FormSection>
          </FormCard>

          <div className="flex justify-end">
            <Button type="submit" loading={saving}>
              <Save size={16} className="mr-2" />
              Save Changes
            </Button>
          </div>
        </form>
      </div>
    </DashboardShell>
  )
}
