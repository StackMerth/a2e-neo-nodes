'use client'

import { useEffect, useState } from 'react'
import { User, Bell, Shield, Lock, KeyRound, Wallet, Save, FileText, Download, Zap, ShieldCheck } from 'lucide-react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, auth, nodeRunner } from '@/lib/api'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'
import { PushNotificationsCard } from '@/components/dashboard/PushNotificationsCard'

export default function SettingsPage() {
  const { user } = useAuth()
  const { toast } = useToast()

  const [prefs, setPrefs] = useState({
    nodeOffline: true,
    payoutSent: true,
    jobCompleted: false,
    jobFailed: true,
    investmentConfirmed: true,
  })

  const togglePref = (key: keyof typeof prefs) => {
    setPrefs(prev => ({ ...prev, [key]: !prev[key] }))
    toast('success', 'Preference updated')
  }

  const [walletInput, setWalletInput] = useState('')
  const [savingWallet, setSavingWallet] = useState(false)
  const [showManualLink, setShowManualLink] = useState(false)
  const [signingLink, setSigningLink] = useState(false)

  // Wallet-adapter sign-to-link flow: prove ownership of the connected
  // wallet by signing a server-issued nonce, then attach the address
  // to the User row. Preferred over the legacy paste flow because the
  // legacy flow accepts any address the user claims without proof.
  const { publicKey, signMessage, wallet } = useWallet()
  const { setVisible: openWalletModal } = useWalletModal()

  async function saveWallet() {
    const candidate = walletInput.trim()
    if (!candidate) return
    setSavingWallet(true)
    try {
      await apiFetch('/v1/portal/user/wallet', { method: 'PATCH', body: { walletAddress: candidate } })
      toast('success', 'Wallet linked. Refresh to see it on your profile.')
      setWalletInput('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save wallet'
      toast('error', message)
    } finally {
      setSavingWallet(false)
    }
  }

  async function signAndLinkWallet() {
    if (!publicKey || !signMessage) {
      openWalletModal(true)
      return
    }
    setSigningLink(true)
    try {
      const address = publicKey.toBase58()
      const { nonce, message } = await auth.linkWalletChallenge(address)
      const encoded = new TextEncoder().encode(message)
      const signatureBytes = await signMessage(encoded)
      // bs58 used because the verify endpoint accepts base58 first
      // (Phantom default) and falls back to base64. Base58 is what
      // every other Solana auth flow on the platform produces.
      const bs58 = await import('bs58')
      const signature = bs58.default.encode(signatureBytes)
      await auth.linkWalletVerify({ walletAddress: address, signature, nonce })
      toast('success', 'Wallet linked. Refresh to see it on your profile.')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not link wallet'
      if (message.toLowerCase().includes('user rejected')) {
        toast('error', 'Cancelled in your wallet.')
      } else {
        toast('error', message)
      }
    } finally {
      setSigningLink(false)
    }
  }

  return (
    <DashboardShell
      title="Settings"
      subtitle="Manage your account and preferences"
    >
      <div className="lg:col-span-3 max-w-3xl mx-auto w-full space-y-6">
        <FormCard
          title="Profile"
          description="Identity attached to this operator account"
          icon={User}
        >
          <FormSection>
            <Row label="Email" value={user?.email ?? 'Not set'} />
            <Row
              label="Wallet"
              valueMono
              value={user?.walletAddress
                ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
                : 'Not connected'}
            />
            <Row
              label="Role"
              value={
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full"
                  style={{ color: 'var(--primary)', background: 'rgba(34,197,94,0.1)' }}
                >
                  {user?.role}
                </span>
              }
            />
            <Row label="Node Runner ID" valueMono value={user?.nodeRunnerId ?? 'Not linked'} />
          </FormSection>
        </FormCard>

        {!user?.walletAddress && (
          <FormCard
            title="Link a Solana wallet"
            description="Email signups land without a wallet. Connect a wallet and sign a one-time message to attach it, or paste an address manually for hardware wallets and multisigs."
            icon={Wallet}
          >
            <FormSection>
              {/* Primary: sign-to-link flow. Connects via wallet-adapter,
                  signs a server-issued nonce, posts the signature back
                  for cryptographic ownership verification. */}
              {!showManualLink ? (
                <div className="space-y-3">
                  {publicKey ? (
                    <>
                      <div
                        className="rounded-md p-3 flex items-center gap-3"
                        style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}
                      >
                        <ShieldCheck size={18} style={{ color: 'var(--primary)' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {wallet?.adapter.name ?? 'Wallet'} connected
                          </p>
                          <p className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                            {publicKey.toBase58()}
                          </p>
                        </div>
                      </div>
                      <Button onClick={signAndLinkWallet} loading={signingLink} className="w-full">
                        <Zap size={14} className="mr-1.5" />
                        Sign to link this wallet
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => openWalletModal(true)} className="w-full">
                      <Wallet size={14} className="mr-1.5" />
                      Connect wallet to link
                    </Button>
                  )}
                  <p className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    Linking via signature proves you own the wallet. Signing a message is free; no on-chain transaction is sent.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowManualLink(true)}
                    className="text-xs font-mono uppercase tracking-[0.16em] hover:opacity-80 transition-opacity"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    + Paste address manually instead
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <input
                      type="text"
                      placeholder="e.g. 6dNUZBg...A9pK"
                      value={walletInput}
                      onChange={e => setWalletInput(e.target.value)}
                      className="flex-1 font-mono text-sm rounded-md px-3 py-2 focus:outline-none focus:border-primary transition-colors"
                      style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-primary)',
                      }}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Button
                      onClick={saveWallet}
                      disabled={savingWallet || walletInput.trim().length < 32}
                    >
                      <Save size={14} className="mr-1" />
                      Save
                    </Button>
                  </div>
                  <p className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    Manual paste does not verify ownership. Use only for wallets you cannot connect to a web app (hardware wallet, multisig, exchange withdrawal address).
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowManualLink(false)}
                    className="text-xs font-mono uppercase tracking-[0.16em] hover:opacity-80 transition-opacity"
                    style={{ color: 'var(--primary)' }}
                  >
                    ← Use connect-and-sign instead
                  </button>
                </div>
              )}
            </FormSection>
          </FormCard>
        )}

        <FormCard
          title="Notification Preferences"
          description="Pick which events trigger an in-app + email notification"
          icon={Bell}
        >
          <FormSection>
            {([
              ['nodeOffline',         'Node Offline',         'Get notified when a node goes offline'],
              ['payoutSent',          'Payout Sent',          'Get notified when a payout is processed'],
              ['jobCompleted',        'Job Completed',        'Get notified when a job completes'],
              ['jobFailed',           'Job Failed',           'Get notified when a job fails'],
              ['investmentConfirmed', 'Investment Confirmed', 'Get notified when payment is confirmed'],
            ] as [keyof typeof prefs, string, string][]).map(([key, label, desc]) => (
              <div
                key={key}
                className="flex items-center justify-between py-3 last:pb-0"
                style={{ borderBottom: '1px solid var(--border-color)' }}
              >
                <div className="min-w-0 pr-4">
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{desc}</p>
                </div>
                <button
                  onClick={() => togglePref(key)}
                  className="relative w-11 h-6 rounded-full transition-colors shrink-0"
                  style={{
                    background: prefs[key] ? 'var(--primary)' : 'var(--bg-elevated)',
                    border: prefs[key] ? 'none' : '1px solid var(--border-color)',
                  }}
                  aria-pressed={prefs[key]}
                  aria-label={`Toggle ${label}`}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                    style={{ transform: prefs[key] ? 'translateX(20px)' : 'translateX(0)' }}
                  />
                </button>
              </div>
            ))}
          </FormSection>
        </FormCard>

        {/* Phase 5 / wave-3: browser web push (VAPID). Lives between
            the in-app toggle list and email preferences so all
            notification-channel toggles cluster together. */}
        <PushNotificationsCard />

        {/* C3 wave 2: weekly digest opt-out. Lives on General Settings
            (was on /payouts/settings) so all general-account toggles
            sit together. */}
        <EmailPreferencesCard />

        {/* C7 wave 1: tax info collection + 1099 export. Lives on
            General Settings (was on /payouts/settings) so identity
            and tax records are managed in one place. */}
        <TaxInfoCard />

        <FormCard
          title="Security"
          description="Password management and two-factor authentication"
          icon={Shield}
        >
          <FormSection>
            <div className="flex gap-3 flex-wrap">
              <Button variant="secondary" size="sm" disabled>
                <Lock size={14} className="mr-1" /> Change Password
              </Button>
              <Button variant="secondary" size="sm" disabled>
                <KeyRound size={14} className="mr-1" /> Enable 2FA
              </Button>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              These features will be available soon.
            </p>
          </FormSection>
        </FormCard>
      </div>
    </DashboardShell>
  )
}

function Row({
  label,
  value,
  valueMono,
}: {
  label: string
  value: React.ReactNode
  valueMono?: boolean
}) {
  return (
    <div
      className="flex items-center justify-between py-2"
      style={{ borderBottom: '1px solid var(--border-color)' }}
    >
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span
        className={`text-sm ${valueMono ? 'font-mono text-xs' : ''}`}
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * Weekly summary email opt-out. Reads digestOptedOut from the profile,
 * persists it via nodeRunner.settings on Save. Self-contained so it
 * does not bleed into the surrounding notification-preferences toggles
 * (those are local UI state only; this one round-trips to the API).
 */
function EmailPreferencesCard() {
  const { toast } = useToast()
  const [optedOut, setOptedOut] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    nodeRunner
      .profile()
      .then((p) => {
        if (cancelled) return
        setOptedOut((p as { digestOptedOut?: boolean }).digestOptedOut ?? false)
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function save() {
    setSaving(true)
    try {
      await nodeRunner.settings({ digestOptedOut: optedOut })
      toast('success', 'Email preferences saved')
      setDirty(false)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <FormCard
      title="Email Preferences"
      description="Weekly summary email with forecast + uptime warnings"
      icon={FileText}
    >
      <FormSection>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!optedOut}
            onChange={(e) => { setOptedOut(!e.target.checked); setDirty(true) }}
            className="mt-1 w-4 h-4"
            style={{ accentColor: 'var(--primary)' }}
          />
          <div className="flex-1">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Send me the weekly summary email
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Mondays at 09:00 UTC: 30-day earnings forecast plus a flag for any node under 90% uptime. Requires a verified email on this account.
            </p>
          </div>
        </label>
        {dirty && (
          <div className="flex justify-end mt-3">
            <Button onClick={save} loading={saving} size="sm">
              <Save size={14} className="mr-1" />
              Save
            </Button>
          </div>
        )}
      </FormSection>
    </FormCard>
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
 * that's what operators want for tax-prep season.
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
