'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowLeft, Save } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
    <motion.div
      className="space-y-6 max-w-2xl"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.div variants={item}>
        <Link href="/payouts" className="text-sm inline-flex items-center gap-1 hover:opacity-80" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> Back to Payouts
        </Link>
        <h1 className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>Payout Settings</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Manage your payout wallet and preferences</p>
      </motion.div>

      <motion.div variants={item}>
        <form onSubmit={handleSave}>
          <div
            className="rounded-xl p-6 space-y-5"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <Input label="Display Name" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
            <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" />
            <Input label="Payout Wallet (Solana)" value={wallet} onChange={e => setWallet(e.target.value)} placeholder="Solana wallet address" />

            <div className="pt-2 flex justify-end">
              <Button type="submit" loading={saving}>
                <Save size={16} className="mr-2" />
                Save Changes
              </Button>
            </div>
          </div>
        </form>
      </motion.div>
    </motion.div>
  )
}
