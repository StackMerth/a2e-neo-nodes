'use client'

import { useState } from 'react'
import { User, Bell, Shield, Lock, KeyRound, Wallet, Save } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { apiFetch } from '@/lib/api'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

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
            description="Email signups land without a wallet. Paste your Solana payout address so settlements, refunds, and referral commission can flow to you."
            icon={Wallet}
          >
            <FormSection>
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
                We never see your private key. This is just the public address you would paste on any other Solana service.
              </p>
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
