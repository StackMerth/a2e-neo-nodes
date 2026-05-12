'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { User, Bell, Shield, Lock, KeyRound, Wallet, Save } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { apiFetch } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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

  // M5.6: wallet attach. Email-first signups land without a wallet;
  // operators paste their Solana address here and the backend syncs it
  // to both User.walletAddress and any linked NodeRunner row.
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
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Wallet</span>
              <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{user?.walletAddress ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}` : 'Not connected'}</span>
            </div>
            <div className="flex justify-between py-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Role</span>
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{ color: 'var(--primary)', background: 'rgba(34,197,94,0.1)' }}
              >
                {user?.role}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span style={{ color: 'var(--text-muted)' }}>Node Runner ID</span>
              <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{user?.nodeRunnerId ?? 'Not linked'}</span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* M5.6: wallet attach. Shown to anyone whose User.walletAddress
          is null, i.e. email-first signups who never went through a
          wallet-bound signup flow. Once set the input hides itself and
          the Profile panel above renders the truncated address. */}
      {!user?.walletAddress && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Wallet size={16} style={{ color: 'var(--text-secondary)' }} />
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Link a Solana wallet</h2>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Email signups land without a wallet. Paste your Solana payout address here so settlements, refunds, and referral commission can flow to you. Base58 format, 32-44 chars.
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="e.g. 6dNUZBg...A9pK"
                value={walletInput}
                onChange={e => setWalletInput(e.target.value)}
                className="flex-1 font-mono text-sm rounded-lg px-3 py-2 focus:outline-none"
                style={{
                  background: 'var(--bg-card)',
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
            <p className="text-[11px] mt-3 font-mono" style={{ color: 'var(--text-muted)' }}>
              We never see your private key. This is just the public address you would paste on any other Solana service.
            </p>
          </div>
        </motion.div>
      )}

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
              ['nodeOffline', 'Node Offline', 'Get notified when a node goes offline'],
              ['payoutSent', 'Payout Sent', 'Get notified when a payout is processed'],
              ['jobCompleted', 'Job Completed', 'Get notified when a job completes'],
              ['jobFailed', 'Job Failed', 'Get notified when a job fails'],
              ['investmentConfirmed', 'Investment Confirmed', 'Get notified when payment is confirmed'],
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
