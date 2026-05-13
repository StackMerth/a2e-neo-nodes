'use client'

import { useState } from 'react'
import { User, Bell, Shield, Lock, KeyRound, Wallet } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { buyer } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

// Loose Solana address validation: base58 alphabet, 32-44 chars.
// Stricter on-chain validity is enforced by the API route + Solana SDK.
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export default function BuyerSettingsPage() {
  const { user } = useAuth()
  const { toast } = useToast()

  const [prefs, setPrefs] = useState({
    requestApproved: true,
    computeReady: true,
    computeExpiring: true,
    computeExpired: true,
  })

  // Wallet edit state. currentWallet tracks what the API last accepted
  // so the display stays correct after save without needing the global
  // auth context to re-fetch. walletInput is what the user is typing.
  const [currentWallet, setCurrentWallet] = useState<string | null>(user?.walletAddress ?? null)
  const [walletInput, setWalletInput] = useState('')
  const [savingWallet, setSavingWallet] = useState(false)

  const togglePref = (key: keyof typeof prefs) => {
    setPrefs(prev => ({ ...prev, [key]: !prev[key] }))
    toast('success', 'Preference updated')
  }

  const handleSaveWallet = async () => {
    const value = walletInput.trim()
    if (!value) {
      toast('error', 'Wallet address required')
      return
    }
    if (!SOL_ADDRESS_RE.test(value)) {
      toast('error', 'Not a valid Solana address (32-44 base58 chars)')
      return
    }
    setSavingWallet(true)
    try {
      const result = (await buyer.settings({ walletAddress: value })) as { walletAddress: string | null }
      setCurrentWallet(result.walletAddress ?? value)
      setWalletInput('')
      toast('success', 'Wallet address saved')
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to save wallet')
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
        {/* Profile */}
        <FormCard
          title="Profile"
          description="Identity attached to this buyer account"
          icon={User}
        >
          <FormSection>
            <Row label="Email" value={user?.email ?? 'Not set'} />
            <Row
              label="Role"
              value={
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full"
                  style={{ color: 'var(--info)', background: 'rgba(59,130,246,0.1)' }}
                >
                  Compute Buyer
                </span>
              }
            />
          </FormSection>
        </FormCard>

        {/* Wallet */}
        <FormCard
          title="Solana Wallet Address"
          description="We send prorated refunds here when you terminate a rental early. Required for refunds."
          icon={Wallet}
        >
          <FormSection>
            <div className="py-2" style={{ borderBottom: '1px solid var(--border-color)' }}>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Current</span>
                <span className="font-mono text-xs" style={{ color: currentWallet ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {currentWallet
                    ? `${currentWallet.slice(0, 6)}...${currentWallet.slice(-6)}`
                    : 'Not connected'}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Paste your Solana wallet address"
                value={walletInput}
                onChange={(e) => setWalletInput(e.target.value)}
                disabled={savingWallet}
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
                variant="primary"
                size="sm"
                onClick={handleSaveWallet}
                disabled={savingWallet || !walletInput.trim()}
              >
                {savingWallet ? 'Saving...' : currentWallet ? 'Update' : 'Save'}
              </Button>
            </div>
            <p className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
              Tip: 32-44 characters, starts with a letter or digit. Valid Solana addresses are base58-encoded.
            </p>
          </FormSection>
        </FormCard>

        {/* Notifications */}
        <FormCard
          title="Notification Preferences"
          description="Pick which events trigger an in-app + email notification"
          icon={Bell}
        >
          <FormSection>
            {([
              ['requestApproved', 'Request Approved', 'Get notified when a compute request is approved'],
              ['computeReady', 'Compute Ready', 'Get notified when your compute allocation is ready to use'],
              ['computeExpiring', 'Compute Expiring', 'Get notified 24 hours before your allocation expires'],
              ['computeExpired', 'Compute Expired', 'Get notified when your compute allocation has ended'],
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

        {/* Security */}
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
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between py-2"
      style={{ borderBottom: '1px solid var(--border-color)' }}
    >
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}
