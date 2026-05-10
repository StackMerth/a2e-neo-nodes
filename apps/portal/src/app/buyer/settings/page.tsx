'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { User, Bell, Shield, Lock, KeyRound, Wallet } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { buyer } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'

// Loose Solana address validation: base58 alphabet, 32-44 chars.
// Stricter on-chain validity is enforced by the API route + Solana SDK.
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
    <motion.div
      className="space-y-6 max-w-2xl"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item}>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Manage your account and preferences</p>
      </motion.div>

      {/* Profile */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <User size={16} style={{ color: 'var(--text-secondary)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Profile</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Email</span>
              <span style={{ color: 'var(--text-primary)' }}>{user?.email ?? 'Not set'}</span>
            </div>
            <div className="flex justify-between py-2">
              <span style={{ color: 'var(--text-muted)' }}>Role</span>
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{ color: 'var(--info)', background: 'rgba(59,130,246,0.1)' }}
              >
                Compute Buyer
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Wallet — editable. Used for receiving prorated refunds when a
          rental is terminated early, and (later) for wallet-based login. */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Wallet size={16} style={{ color: 'var(--text-secondary)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Solana Wallet Address</h2>
          </div>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            We send prorated refunds here when you terminate a rental early. Required for refunds.
          </p>

          <div className="mb-3 py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
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
              className="flex-1 px-3 py-2 rounded-lg text-xs font-mono"
              style={{
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
              }}
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
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Tip: 32-44 characters, starts with a letter or digit. Valid Solana addresses are base58-encoded.
          </p>
        </div>
      </motion.div>

      {/* Notifications */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Bell size={16} style={{ color: 'var(--text-secondary)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Notification Preferences</h2>
          </div>
          <div className="space-y-1">
            {([
              ['requestApproved', 'Request Approved', 'Get notified when a compute request is approved'],
              ['computeReady', 'Compute Ready', 'Get notified when your compute allocation is ready to use'],
              ['computeExpiring', 'Compute Expiring', 'Get notified 24 hours before your allocation expires'],
              ['computeExpired', 'Compute Expired', 'Get notified when your compute allocation has ended'],
            ] as [keyof typeof prefs, string, string][]).map(([key, label, desc]) => (
              <div
                key={key}
                className="flex items-center justify-between py-3 last:border-0"
                style={{ borderBottom: '1px solid var(--glass-border)' }}
              >
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{label}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</p>
                </div>
                <button
                  onClick={() => togglePref(key)}
                  className="relative w-11 h-6 rounded-full transition-colors"
                  style={{
                    background: prefs[key] ? 'var(--primary)' : 'var(--bg-card-hover)',
                    border: prefs[key] ? 'none' : '1px solid var(--border-color)',
                  }}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                    style={{ transform: prefs[key] ? 'translateX(20px)' : 'translateX(0)' }}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Security */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Shield size={16} style={{ color: 'var(--text-secondary)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Security</h2>
          </div>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>Password management and two-factor authentication</p>
          <div className="flex gap-3">
            <Button variant="secondary" size="sm" disabled>
              <Lock size={14} className="mr-1" /> Change Password
            </Button>
            <Button variant="secondary" size="sm" disabled>
              <KeyRound size={14} className="mr-1" /> Enable 2FA
            </Button>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>These features will be available soon.</p>
        </div>
      </motion.div>
    </motion.div>
  )
}
