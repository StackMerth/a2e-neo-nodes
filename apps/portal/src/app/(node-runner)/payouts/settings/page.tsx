'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'

export default function PayoutSettingsPage() {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [wallet, setWallet] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const profile = await nodeRunner.profile() as { name: string; email: string | null; walletAddress: string }
        setName(profile.name)
        setEmail(profile.email ?? '')
        setWallet(profile.walletAddress)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await nodeRunner.settings({ name: name || undefined, email: email || undefined, walletAddress: wallet || undefined })
      toast('success', 'Settings saved')
    } catch (err) { toast('error', err instanceof Error ? err.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="animate-fadeIn"><div className="animate-shimmer h-64 rounded-xl" /></div>

  return (
    <div className="space-y-6 animate-fadeIn max-w-2xl">
      <div>
        <Link href="/payouts" className="text-sm text-text-muted hover:text-text-secondary">&larr; Back to Payouts</Link>
        <h1 className="text-2xl font-bold text-text-primary mt-1">Payout Settings</h1>
        <p className="text-sm text-text-muted mt-1">Manage your payout wallet and preferences</p>
      </div>

      <form onSubmit={handleSave}>
        <Card className="p-6 space-y-5">
          <Input label="Display Name" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
          <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" />
          <Input label="Payout Wallet (Solana)" value={wallet} onChange={e => setWallet(e.target.value)} placeholder="Solana wallet address" />

          <div className="pt-2 flex justify-end">
            <Button type="submit" loading={saving}>Save Changes</Button>
          </div>
        </Card>
      </form>
    </div>
  )
}
