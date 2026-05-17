'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, Save, User, Wallet, CalendarClock, PiggyBank, ArrowDownToLine, Zap, TrendingDown, FileText, Download } from 'lucide-react'
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
  const [spent, setSpent] = useState(0)
  const [nextUnlockAt, setNextUnlockAt] = useState<string | null>(null)
  const [cooldownHours, setCooldownHours] = useState(48)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  // Withdraw dialog: inline expansion with editable destination wallet.
  // Pre-fills with the operator's saved wallet; optional save flag
  // persists the override back to the profile.
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawWallet, setWithdrawWallet] = useState('')
  const [saveWallet, setSaveWallet] = useState(false)

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
        setSpent(modeInfo.spent ?? 0)
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

  function openWithdrawDialog() {
    if (available <= 0) {
      toast('error', pending > 0 ? `No unlocked balance yet. $${pending.toFixed(2)} is still in cool-down.` : 'No unpaid balance to withdraw')
      return
    }
    setWithdrawWallet(wallet) // pre-fill with the saved wallet
    setSaveWallet(false)
    setWithdrawOpen(true)
  }

  const SOLANA_ADDR_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
  const withdrawWalletValid = SOLANA_ADDR_REGEX.test(withdrawWallet.trim())

  async function handleWithdrawNow() {
    const trimmed = withdrawWallet.trim()
    if (!withdrawWalletValid) {
      toast('error', 'Destination wallet does not look like a Solana address')
      return
    }
    setWithdrawing(true)
    try {
      const result = await nodeRunner.withdrawNow({
        // Only send override when it differs from the saved wallet so
        // the request stays compact in the no-change happy path.
        walletAddress: trimmed !== wallet ? trimmed : undefined,
        saveWallet: trimmed !== wallet && saveWallet,
      })
      const successCount = result.settlements.filter((s) => s.success).length
      const totalCount = result.settlements.length
      if (successCount === totalCount) {
        toast('success', `Withdrew $${result.totalPaid.toFixed(2)} to ${result.destinationWallet.slice(0, 6)}...${result.destinationWallet.slice(-4)}`)
      } else {
        toast('error', `Partial withdrawal: ${successCount}/${totalCount} settlements succeeded`)
      }
      setWithdrawOpen(false)
      // Refresh state so balance + mode + saved wallet reflect the new reality.
      await loadAll()
    } catch (err) {
      // 403 lock errors come back with the lockedUntil field — surface it nicely.
      const msg = err instanceof Error ? err.message : 'Withdrawal failed'
      toast('error', msg)
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
            <div className={`grid gap-4 ${spent > 0 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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
              {/* Internal-spend tile. Only rendered when the operator
                  has spent any balance on rentals (dual-role user).
                  Already subtracted from Available — shown here so
                  the math is transparent. */}
              {spent > 0 && (
                <div
                  className="rounded-md p-4"
                  style={{
                    background: 'rgba(59,130,246,0.06)',
                    border: '1px solid rgba(59,130,246,0.25)',
                  }}
                >
                  <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2 flex items-center gap-1" style={{ color: 'var(--info, #3b82f6)' }}>
                    <TrendingDown size={12} /> Spent on rentals
                  </p>
                  <p className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    ${spent.toFixed(2)}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Already subtracted from Available.
                  </p>
                </div>
              )}
            </div>

            {!withdrawOpen ? (
              <div className="flex justify-end mt-4">
                <Button
                  type="button"
                  onClick={openWithdrawDialog}
                  disabled={available <= 0}
                >
                  <ArrowDownToLine size={16} className="mr-2" />
                  Withdraw ${available.toFixed(2)}
                </Button>
              </div>
            ) : (
              // Inline withdraw dialog. Editable destination wallet so
              // operators who don't have a wallet saved on profile (or
              // who want to send to a different one this time) can do
              // it without changing their permanent settings first.
              <div
                className="mt-4 rounded-md p-4 space-y-3"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
              >
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Send ${available.toFixed(2)} to this wallet
                  </label>
                  <input
                    type="text"
                    value={withdrawWallet}
                    onChange={(e) => setWithdrawWallet(e.target.value)}
                    placeholder="Solana wallet address"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="w-full rounded-md px-3 py-2 text-sm font-mono"
                    style={{
                      background: 'var(--bg-card)',
                      border:
                        withdrawWallet.trim() === '' || withdrawWalletValid
                          ? '1px solid var(--border-color)'
                          : '1px solid rgba(239, 68, 68, 0.5)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  {withdrawWallet.trim() !== '' && !withdrawWalletValid && (
                    <p className="text-xs mt-1" style={{ color: '#ef4444' }}>
                      That doesn&rsquo;t look like a Solana address (32-44 base58 characters).
                    </p>
                  )}
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {withdrawWallet.trim() === wallet
                      ? 'Using your saved payout wallet.'
                      : 'One-time destination, different from your saved wallet.'}
                  </p>
                </div>

                {withdrawWallet.trim() !== '' && withdrawWallet.trim() !== wallet && (
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={saveWallet}
                      onChange={(e) => setSaveWallet(e.target.checked)}
                      className="rounded"
                    />
                    Save this wallet to my profile (replaces the saved one)
                  </label>
                )}

                <div className="flex gap-2 justify-end pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setWithdrawOpen(false)}
                    disabled={withdrawing}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleWithdrawNow}
                    loading={withdrawing}
                    disabled={!withdrawWalletValid}
                  >
                    <ArrowDownToLine size={16} className="mr-2" />
                    Confirm withdrawal
                  </Button>
                </div>
              </div>
            )}

            <div
              className="mt-4 text-xs rounded-md p-3 leading-relaxed"
              style={{
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.2)',
                color: 'var(--text-muted)',
              }}
            >
              Earnings sit in cool-down for {cooldownHours} hours after they accrue, giving us a buyer-dispute window. After that, the amount moves to <span className="text-primary font-semibold" style={{ color: 'var(--primary)' }}>Available</span> and you can withdraw at any time. Two safety nets fire even if you&rsquo;re on hold: the platform forces a payout when your balance exceeds $50,000, or after 180 days of inactivity.
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

        {/* C7 wave 1: tax info card lives outside the main form so
            saving tax data doesn't interfere with the payout-mode
            form's dirty state, and so the download CTA is always
            available regardless of unsaved changes. */}
        <TaxInfoCard />
      </div>
    </DashboardShell>
  )
}

/**
 * C7 wave 1: tax-info collection + per-year CSV download.
 *
 * Form is always optional. The CSV still works for operators who
 * don't fill it in — they just won't get pre-filled legal-name/TIN
 * cells in the operator-header row. Storing the TIN in plain text
 * on the server is a known tradeoff (encryption-at-rest follow-up
 * noted in the plan); we mask it to last-4 on read paths so a
 * leaked browser session doesn't expose the full id.
 *
 * Download CTA defaults the year picker to "last completed year" —
 * that's what operators want for tax-prep season. They can pick any
 * year from 2020 up to current.
 */
function TaxInfoCard() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [legalName, setLegalName] = useState('')
  const [taxIdType, setTaxIdType] = useState<'SSN' | 'EIN'>('SSN')
  const [taxId, setTaxId] = useState('')
  const [taxAddress, setTaxAddress] = useState('')
  const [taxJurisdiction, setTaxJurisdiction] = useState('US')
  const [taxIdLast4, setTaxIdLast4] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [w9SubmittedAt, setW9SubmittedAt] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const thisYear = new Date().getUTCFullYear()
  // Default to last completed year for tax-prep season; falls back to
  // current year if it's January and there's no prior year yet.
  const [year, setYear] = useState(thisYear - 1 < 2020 ? thisYear : thisYear - 1)

  useEffect(() => {
    let cancelled = false
    nodeRunner
      .taxInfo()
      .then((r) => {
        if (cancelled) return
        setLegalName(r.legalName)
        if (r.taxIdType) setTaxIdType(r.taxIdType)
        setTaxIdLast4(r.taxIdLast4)
        setSubmitted(r.taxIdSubmitted)
        setTaxAddress(r.taxAddress)
        setTaxJurisdiction(r.taxJurisdiction || 'US')
        setW9SubmittedAt(r.w9SubmittedAt)
      })
      .catch(() => { /* 404 = no profile yet; quiet */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    if (!legalName.trim() || !taxId.trim() || !taxAddress.trim()) {
      toast('error', 'Legal name, TIN, and address are all required')
      return
    }
    setSaving(true)
    try {
      const r = await nodeRunner.updateTaxInfo({
        legalName: legalName.trim(),
        taxIdType,
        taxId: taxId.trim(),
        taxAddress: taxAddress.trim(),
        taxJurisdiction,
      })
      toast('success', 'Tax info saved')
      setW9SubmittedAt(r.w9SubmittedAt)
      setSubmitted(true)
      // Mask the freshly-saved TIN to last 4 + clear the input — same
      // shape as the read-back view, so the UX is consistent after save.
      const digits = taxId.replace(/\D/g, '')
      setTaxIdLast4(digits.slice(-4))
      setTaxId('')
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to save tax info')
    } finally {
      setSaving(false)
    }
  }

  async function handleDownload() {
    setDownloading(true)
    try {
      await nodeRunner.downloadTaxYear(year)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Tax CSV download failed')
    } finally {
      setDownloading(false)
    }
  }

  if (loading) return null

  return (
    <FormCard
      title="Tax info (optional)"
      description="Required only if you want pre-filled 1099-MISC export. Stored privately; never shared with buyers."
      icon={FileText}
    >
      <FormSection>
        {submitted && w9SubmittedAt && (
          <div
            className="rounded-md p-3 mb-2 text-xs flex items-center gap-2"
            style={{
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.25)',
              color: 'var(--primary)',
            }}
          >
            <FileText size={12} />
            <span>
              W-9 on file since {new Date(w9SubmittedAt).toLocaleDateString()}.
              TIN ends in <span className="font-mono">{taxIdLast4}</span>. You can update below to replace.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Input
              label="Legal Name (as it appears on your tax filings)"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Jane Q. Operator"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              TIN Type
            </label>
            <div className="flex gap-2">
              {(['SSN', 'EIN'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setTaxIdType(opt)}
                  className="px-4 py-2 rounded-md text-sm font-medium transition-all"
                  style={taxIdType === opt
                    ? { background: 'var(--primary)', color: '#fff' }
                    : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }
                  }
                >
                  {opt === 'SSN' ? 'SSN (individual)' : 'EIN (entity)'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Input
              label={submitted ? `TIN (replace; current ends in ${taxIdLast4})` : 'TIN'}
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              placeholder={taxIdType === 'SSN' ? '123-45-6789' : '12-3456789'}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Address (single line)
            </label>
            <textarea
              className="w-full rounded-md px-3 py-2 text-sm"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
              value={taxAddress}
              onChange={(e) => setTaxAddress(e.target.value)}
              placeholder="123 Main St, City, State, ZIP"
              rows={2}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Jurisdiction
            </label>
            <select
              value={taxJurisdiction}
              onChange={(e) => setTaxJurisdiction(e.target.value)}
              className="w-full rounded-md px-3 py-2 text-sm"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            >
              <option value="US">United States</option>
              <option value="INTERNATIONAL" disabled>International — coming soon (W-8BEN)</option>
            </select>
          </div>
        </div>

        <div className="flex justify-end mt-3">
          <Button onClick={handleSave} loading={saving}>
            <Save size={14} className="mr-2" />
            Save tax info
          </Button>
        </div>

        {/* Per-year CSV download. Separate visual block from the form
            so operators understand they can download even if they
            haven't filled in W-9 (it just won't pre-fill those cells). */}
        <div
          className="mt-6 pt-4 flex flex-wrap items-end gap-3"
          style={{ borderTop: '1px solid var(--border-color)' }}
        >
          <div>
            <label className="block text-xs font-mono uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Download tax-year CSV
            </label>
            <select
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="rounded-md px-3 py-2 text-sm"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            >
              {Array.from({ length: thisYear - 2019 }, (_, i) => thisYear - i).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <Button variant="secondary" onClick={handleDownload} loading={downloading}>
            <Download size={14} className="mr-2" />
            Download {year} CSV
          </Button>
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          The CSV breaks earnings down by month with payout tx hashes for audit. Hand to your CPA for 1099-MISC prep. We don&apos;t auto-file with the IRS — that&apos;s on you.
        </p>
      </FormSection>
    </FormCard>
  )
}
