'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, Save, User, Wallet, CalendarClock, PiggyBank, ArrowDownToLine, Zap } from 'lucide-react'
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

type PayoutMode = 'AUTO' | 'MANUAL' | 'SCHEDULED'

interface Profile {
  name: string
  email: string | null
  walletAddress: string
  payoutThreshold: number
  payoutFrequency: string
  payoutDayOfWeek: number | null
  payoutDayOfMonth: number | null
}

const MODE_OPTIONS: Array<{ id: PayoutMode; label: string; description: string }> = [
  {
    id: 'AUTO',
    label: 'Auto',
    description: 'Settlements fire automatically when your balance crosses the threshold on the chosen schedule. Default.',
  },
  {
    id: 'MANUAL',
    label: 'Manual',
    description: 'Earnings accumulate on the platform indefinitely. You click "Withdraw now" when you want to cash out.',
  },
  {
    id: 'SCHEDULED',
    label: 'Scheduled',
    description: 'Earnings accumulate until the date below. On that date we auto-send the full balance and switch you back to Auto.',
  },
]

// Format an ISO datetime for the <input type="datetime-local"> control,
// which expects "YYYY-MM-DDTHH:mm" in the user's local time. The portal
// elsewhere assumes UTC; round-trip is fine because we send the iso
// string back out on submit and the API parses it as UTC.
function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Render an ISO timestamp as a short countdown phrase. Pending funds
// use this to show the operator when the next chunk unlocks without
// requiring a live ticker — slight staleness on the minute is fine.
function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `in ${days} day${days === 1 ? '' : 's'}`
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
  const [mode, setMode] = useState<PayoutMode>('AUTO')
  const [scheduledAt, setScheduledAt] = useState<string>('') // datetime-local string
  const [available, setAvailable] = useState(0)
  const [pending, setPending] = useState(0)
  const [nextUnlockAt, setNextUnlockAt] = useState<string | null>(null)
  const [cooldownHours, setCooldownHours] = useState(48)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  async function loadAll() {
    try {
      const [profile, modeInfo] = await Promise.all([
        nodeRunner.profile() as Promise<Profile>,
        nodeRunner.payoutMode().catch(() => null),
      ])
      setName(profile.name)
      setEmail(profile.email ?? '')
      setWallet(profile.walletAddress)
      setThreshold(profile.payoutThreshold ?? 10)
      setFrequency(profile.payoutFrequency ?? 'WEEKLY')
      setDayOfWeek(profile.payoutDayOfWeek ?? 1)
      setDayOfMonth(profile.payoutDayOfMonth ?? 1)
      if (modeInfo) {
        setMode(modeInfo.mode)
        setScheduledAt(modeInfo.scheduledAt ? toLocalDatetimeInput(modeInfo.scheduledAt) : '')
        setAvailable(modeInfo.available)
        setPending(modeInfo.pending)
        setNextUnlockAt(modeInfo.nextUnlockAt)
        setCooldownHours(modeInfo.cooldownHours)
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (mode === 'SCHEDULED' && !scheduledAt) {
      toast('error', 'Pick a date for scheduled payouts')
      return
    }
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
        payoutMode: mode,
        payoutScheduledAt: mode === 'SCHEDULED' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      })
      toast('success', 'Settings saved')
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleWithdrawNow() {
    if (available <= 0) {
      toast('error', pending > 0 ? `No unlocked balance yet. $${pending.toFixed(2)} is still in cool-down.` : 'No unpaid balance to withdraw')
      return
    }
    if (!confirm(`Withdraw $${available.toFixed(2)} from the platform to your wallet?`)) {
      return
    }
    setWithdrawing(true)
    try {
      const result = await nodeRunner.withdrawNow()
      const successCount = result.settlements.filter((s) => s.success).length
      const totalCount = result.settlements.length
      if (successCount === totalCount) {
        toast('success', `Withdrew $${result.totalPaid.toFixed(2)} in ${successCount} settlement${successCount === 1 ? '' : 's'}`)
      } else {
        toast('error', `Partial withdrawal: ${successCount}/${totalCount} settlements succeeded`)
      }
      // Refresh state so balance + mode reflect the new reality.
      await loadAll()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Withdrawal failed')
    } finally {
      setWithdrawing(false)
    }
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

        {/* Platform balance — split into Available (past the cool-down)
            and Pending (still in cool-down). Lives outside the main
            form so withdrawing isn't blocked by unsaved settings
            changes. */}
        <FormCard
          title="Platform Balance"
          description="Earnings sitting on the platform, not yet paid out to your wallet"
          icon={PiggyBank}
        >
          <FormSection>
            <div className="grid sm:grid-cols-2 gap-4">
              <div
                className="rounded-md p-4"
                style={{
                  background: 'rgba(34,197,94,0.06)',
                  border: '1px solid rgba(34,197,94,0.25)',
                }}
              >
                <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--primary)' }}>
                  Available
                </p>
                <p className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  ${available.toFixed(2)}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {available > 0 ? 'Withdrawable right now.' : 'Nothing past the cool-down yet.'}
                </p>
              </div>
              <div
                className="rounded-md p-4"
                style={{
                  background: 'rgba(245,158,11,0.06)',
                  border: '1px solid rgba(245,158,11,0.25)',
                }}
              >
                <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--warning, #f59e0b)' }}>
                  Pending ({cooldownHours}h cool-down)
                </p>
                <p className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  ${pending.toFixed(2)}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {pending > 0 && nextUnlockAt
                    ? `First chunk unlocks ${formatRelative(nextUnlockAt)}.`
                    : 'No earnings in cool-down.'}
                </p>
              </div>
            </div>

            <div className="flex justify-end mt-4">
              <Button
                type="button"
                onClick={handleWithdrawNow}
                loading={withdrawing}
                disabled={available <= 0}
              >
                <ArrowDownToLine size={16} className="mr-2" />
                Withdraw ${available.toFixed(2)}
              </Button>
            </div>

            <div
              className="mt-4 text-xs rounded-md p-3 leading-relaxed"
              style={{
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.2)',
                color: 'var(--text-muted)',
              }}
            >
              Earnings sit in cool-down for {cooldownHours} hours after they accrue, giving us a buyer-dispute window. After that, the amount moves to <span className="text-primary font-semibold" style={{ color: 'var(--primary)' }}>Available</span> and you can withdraw at any time. Two safety nets fire even if you&rsquo;re on hold: the platform forces a payout when your balance exceeds $10,000, or after 180 days of inactivity.
            </div>
          </FormSection>
        </FormCard>

        <form onSubmit={handleSave} className="space-y-6">
          {/* Payout mode picker. Drives whether settlements auto-fire,
              hold on the platform until you click Withdraw now, or hold
              until a specific date. */}
          <FormCard
            title="Payout Mode"
            description="Where do your earnings go when they're settled"
            icon={Zap}
          >
            <FormSection>
              <div className="grid gap-3">
                {MODE_OPTIONS.map((opt) => {
                  const active = mode === opt.id
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setMode(opt.id)}
                      className="text-left rounded-md p-4 transition-all"
                      style={
                        active
                          ? { background: 'rgba(34,197,94,0.08)', border: '1px solid var(--primary)', boxShadow: '0 0 0 1px var(--primary)' }
                          : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                      }
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="w-4 h-4 rounded-full flex-shrink-0"
                          style={
                            active
                              ? { background: 'var(--primary)', boxShadow: '0 0 0 4px rgba(34,197,94,0.2)' }
                              : { background: 'transparent', border: '2px solid var(--border-light, var(--border-color))' }
                          }
                        />
                        <div className="flex-1">
                          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {opt.label}
                          </p>
                          <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                            {opt.description}
                          </p>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>

              {mode === 'SCHEDULED' && (
                <div className="mt-4">
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Scheduled payout date &amp; time
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    min={toLocalDatetimeInput(new Date().toISOString())}
                    className="w-full rounded-md px-4 py-2.5 text-sm"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                    required
                  />
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    On this date the platform will auto-send your full balance and switch you back to Auto mode.
                  </p>
                </div>
              )}
            </FormSection>
          </FormCard>

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
            title="Auto-Payout Preferences"
            description="Threshold + schedule used when Payout Mode = Auto"
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
