'use client'

import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'

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

  return (
    <div className="space-y-6 animate-fadeIn max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted mt-1">Manage your account and preferences</p>
      </div>

      {/* Profile */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Profile</h2>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between py-2 border-b border-border/50">
            <span className="text-text-muted">Email</span>
            <span className="text-text-primary">{user?.email ?? 'Not set'}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border/50">
            <span className="text-text-muted">Wallet</span>
            <span className="text-text-primary font-mono text-xs">{user?.walletAddress ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}` : 'Not connected'}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-border/50">
            <span className="text-text-muted">Role</span>
            <span className="text-accent text-xs font-medium px-2 py-0.5 rounded-full bg-accent/10">{user?.role}</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-text-muted">Node Runner ID</span>
            <span className="text-text-secondary font-mono text-xs">{user?.nodeRunnerId ?? 'Not linked'}</span>
          </div>
        </div>
      </Card>

      {/* Notifications */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Notification Preferences</h2>
        <div className="space-y-1">
          {([
            ['nodeOffline', 'Node Offline', 'Get notified when a node goes offline'],
            ['payoutSent', 'Payout Sent', 'Get notified when a payout is processed'],
            ['jobCompleted', 'Job Completed', 'Get notified when a job completes'],
            ['jobFailed', 'Job Failed', 'Get notified when a job fails'],
            ['investmentConfirmed', 'Investment Confirmed', 'Get notified when payment is confirmed'],
          ] as [keyof typeof prefs, string, string][]).map(([key, label, desc]) => (
            <div key={key} className="flex items-center justify-between py-3 border-b border-border/50 last:border-0">
              <div>
                <p className="text-sm text-text-primary">{label}</p>
                <p className="text-xs text-text-muted">{desc}</p>
              </div>
              <button
                onClick={() => togglePref(key)}
                className={`relative w-11 h-6 rounded-full transition-colors ${prefs[key] ? 'bg-accent' : 'bg-surface-hover border border-border'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${prefs[key] ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          ))}
        </div>
      </Card>

      {/* Security */}
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-text-primary mb-4">Security</h2>
        <p className="text-sm text-text-muted mb-4">Password management and two-factor authentication</p>
        <div className="flex gap-3">
          <Button variant="secondary" size="sm" disabled>Change Password</Button>
          <Button variant="secondary" size="sm" disabled>Enable 2FA</Button>
        </div>
        <p className="text-xs text-text-muted mt-2">These features will be available soon.</p>
      </Card>
    </div>
  )
}
