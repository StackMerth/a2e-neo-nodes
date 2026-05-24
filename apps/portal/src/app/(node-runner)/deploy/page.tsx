'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Rocket, CircleCheck, Hash, Wallet as WalletIcon, Zap } from 'lucide-react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { buyer, nodeRunner } from '@/lib/api'
import { useUsdcPayment } from '@/hooks/useUsdcPayment'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'

interface GpuTier {
  id: string
  name: string
  price: number
  dailyYield: number
}

const GPU_TIERS: GpuTier[] = [
  { id: 'H100', name: 'H100', price: 2500, dailyYield: 140.15 },
  { id: 'H200', name: 'H200', price: 3125, dailyYield: 179.85 },
  { id: 'B200', name: 'B200', price: 5250, dailyYield: 321.10 },
  { id: 'B300', name: 'B300', price: 7500, dailyYield: 431.75 },
  { id: 'GB300', name: 'GB300', price: 9000, dailyYield: 499.35 },
]

const TIER_STYLES: Record<string, { border: string; bg: string; text: string; glow: string; ring: string }> = {
  H100: {
    border: 'rgba(34,197,94,0.4)',
    bg: 'rgba(34,197,94,0.05)',
    text: 'var(--success)',
    glow: '0 0 20px rgba(34,197,94,0.1)',
    ring: 'rgba(34,197,94,0.5)',
  },
  H200: {
    border: 'rgba(59,130,246,0.4)',
    bg: 'rgba(59,130,246,0.05)',
    text: 'var(--info)',
    glow: '0 0 20px rgba(59,130,246,0.1)',
    ring: 'rgba(59,130,246,0.5)',
  },
  B200: {
    border: 'rgba(139,92,246,0.4)',
    bg: 'rgba(139,92,246,0.05)',
    text: '#8b5cf6',
    glow: '0 0 20px rgba(139,92,246,0.1)',
    ring: 'rgba(139,92,246,0.5)',
  },
  B300: {
    border: 'rgba(245,158,11,0.4)',
    bg: 'rgba(245,158,11,0.05)',
    text: 'var(--warning)',
    glow: '0 0 20px rgba(245,158,11,0.1)',
    ring: 'rgba(245,158,11,0.5)',
  },
  GB300: {
    border: 'rgba(239,68,68,0.4)',
    bg: 'rgba(239,68,68,0.05)',
    text: 'var(--danger)',
    glow: '0 0 20px rgba(239,68,68,0.1)',
    ring: 'rgba(239,68,68,0.5)',
  },
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function DeployPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [selectedTier, setSelectedTier] = useState<string | null>(null)
  const [nodeCount, setNodeCount] = useState(1)
  const [txHash, setTxHash] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Wallet sign-to-pay support. Operators with a connected wallet can
  // sign a USDC transfer in their wallet rather than copy-pasting a
  // hash. The paste field remains as a fallback for hardware-wallet
  // or off-portal payment paths.
  const { publicKey, wallet } = useWallet()
  const { setVisible: openWalletModal } = useWalletModal()
  const { pay: walletPay } = useUsdcPayment()
  const [topupDestination, setTopupDestination] = useState<{ wallet: string | null; configured: boolean; network: string } | null>(null)
  const [showManualPaste, setShowManualPaste] = useState(false)
  const [walletPhase, setWalletPhase] = useState<'idle' | 'signing' | 'submitting'>('idle')
  useEffect(() => {
    // Deployment payments go to the same platform-side USDC wallet
    // that buyer topups go to (custodial setup). Re-using the
    // /v1/buyer/balance/topup-destination endpoint avoids duplicating
    // wallet config in two places.
    buyer.balance.topupDestination()
      .then((r) => setTopupDestination({ wallet: r.wallet, configured: r.configured, network: r.network }))
      .catch(() => { /* fail silently; the paste fallback still works */ })
  }, [])

  const tier = GPU_TIERS.find(t => t.id === selectedTier)
  const totalCost = tier ? tier.price * nodeCount : 0
  const monthlyYield = tier ? tier.dailyYield * 30 * nodeCount : 0
  const roi30d = tier ? ((tier.dailyYield * 30) / tier.price) * 100 : 0

  const walletConnected = !!publicKey
  const walletPaySelected = walletConnected && !showManualPaste

  async function handleSubmit() {
    if (!selectedTier) {
      toast('error', 'Please select a GPU tier')
      return
    }
    if (!walletPaySelected && !txHash.trim()) {
      toast('error', 'Enter a transaction hash, or connect a wallet to sign automatically')
      return
    }
    if (walletPaySelected && (!topupDestination?.configured || !topupDestination.wallet)) {
      toast('error', 'Topup destination not configured. Use manual paste or contact support.')
      return
    }

    setSubmitting(true)

    // Wallet sign-and-pay: sign in wallet first, take the signature
    // as the txHash. Any throw (user rejection, insufficient USDC,
    // RPC fail) bails before we touch the deploy endpoint so a
    // failed pay never leaves an orphan PENDING deployment behind.
    let resolvedTxHash = txHash.trim()
    if (walletPaySelected) {
      try {
        setWalletPhase('signing')
        const { signature } = await walletPay({
          recipient: topupDestination!.wallet!,
          amountUsd: totalCost,
        })
        resolvedTxHash = signature
        setWalletPhase('submitting')
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Wallet payment failed'
        if (msg.toLowerCase().includes('user rejected')) {
          toast('error', 'Cancelled in your wallet.')
        } else {
          toast('error', msg)
        }
        setWalletPhase('idle')
        setSubmitting(false)
        return
      }
    }

    try {
      await nodeRunner.deploy({
        gpuTier: selectedTier,
        nodeCount,
        txHash: resolvedTxHash,
        deploymentNote: note.trim() || undefined,
      })
      toast('success', 'Deployment request submitted successfully')
      router.push('/deployments')
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit deployment request')
    } finally {
      setSubmitting(false)
      setWalletPhase('idle')
    }
  }

  return (
    <motion.div
      className="space-y-8"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header — proper card-style spacing. The previous version
          used an absolutely-positioned tinted background with py-6
          only on the wrapper, which made the green tint hug the title
          and subtitle too tightly (no horizontal breathing room, no
          visible border, gradient cut off mid-character on right edge
          of narrow viewports). Switching to padded card with a subtle
          brand-tinted border + gradient on the inside. */}
      <motion.div
        variants={item}
        className="rounded-2xl px-5 sm:px-8 py-6 sm:py-7"
        style={{
          background: 'linear-gradient(to bottom right, rgba(34,197,94,0.07), rgba(34,197,94,0.01) 60%, transparent)',
          border: '1px solid rgba(34, 197, 94, 0.18)',
        }}
      >
        <div className="flex items-center gap-3">
          <Rocket size={28} style={{ color: 'var(--primary)' }} />
          <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Deploy a Node</h1>
        </div>
        <p className="mt-2 text-sm sm:text-base max-w-2xl" style={{ color: 'var(--text-muted)' }}>
          Select your GPU tier, choose how many nodes to deploy, and submit payment.
        </p>
      </motion.div>

      {/* GPU Tier Selector */}
      <motion.div variants={item}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Select GPU Tier</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {GPU_TIERS.map(t => {
            const isSelected = selectedTier === t.id
            const tierRoi = ((t.dailyYield * 30) / t.price) * 100
            const ts = TIER_STYLES[t.id]!
            return (
              <button
                key={t.id}
                onClick={() => setSelectedTier(t.id)}
                className="relative text-left rounded-xl p-5 transition-all duration-200"
                style={isSelected
                  ? {
                      border: `1px solid ${ts.border}`,
                      background: ts.bg,
                      boxShadow: `${ts.glow}, 0 0 0 1px ${ts.ring}`,
                    }
                  : {
                      border: '1px solid var(--border-color)',
                      background: 'var(--glass-bg)',
                    }
                }
              >
                {isSelected && (
                  <div className="absolute top-3 right-3">
                    <CircleCheck size={20} style={{ color: ts.text }} />
                  </div>
                )}
                <div
                  className="text-lg font-bold mb-1"
                  style={{ color: isSelected ? ts.text : 'var(--text-primary)' }}
                >
                  {t.name}
                </div>
                <div className="text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
                  ${t.price.toLocaleString()}
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-muted)' }}>Daily Yield</span>
                    <span className="font-medium" style={{ color: 'var(--primary)' }}>${t.dailyYield.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-muted)' }}>30d ROI</span>
                    <span className="font-medium" style={{ color: 'var(--primary)' }}>{tierRoi.toFixed(1)}%</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </motion.div>

      {/* Node Count */}
      <motion.div variants={item}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Number of Nodes</h2>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => setNodeCount(n)}
              className="w-14 h-14 rounded-xl font-bold text-lg transition-all duration-200"
              style={nodeCount === n
                ? { background: 'var(--primary)', color: '#fff', boxShadow: '0 0 10px rgba(34,197,94,0.2)' }
                : { background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
              }
            >
              {n}
            </button>
          ))}
        </div>
      </motion.div>

      {/* Cost Summary */}
      {tier && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6"
            style={{
              background: 'linear-gradient(to right, rgba(34,197,94,0.05), var(--glass-bg))',
              border: '1px solid rgba(34,197,94,0.2)',
            }}
          >
            <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Cost Summary</h2>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span style={{ color: 'var(--text-muted)' }}>{tier.name} x {nodeCount}</span>
                <span style={{ color: 'var(--text-secondary)' }}>${tier.price.toLocaleString()} x {nodeCount}</span>
              </div>
              <div className="pt-3 flex justify-between" style={{ borderTop: '1px solid var(--border-color)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Total</span>
                <span className="text-2xl font-bold" style={{ color: 'var(--primary)' }}>${totalCost.toLocaleString()}</span>
              </div>
              <div className="pt-3 space-y-1.5" style={{ borderTop: '1px solid var(--border-color)' }}>
                <div className="flex justify-between text-sm">
                  <span style={{ color: 'var(--text-muted)' }}>Est. Monthly Yield</span>
                  <span className="font-medium" style={{ color: 'var(--primary)' }}>${monthlyYield.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span style={{ color: 'var(--text-muted)' }}>30-Day ROI</span>
                  <span className="font-medium" style={{ color: 'var(--primary)' }}>{roi30d.toFixed(1)}%</span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Payment — wallet sign-to-pay preferred when a wallet is
          connected, paste form as fallback for hardware/exchange paths. */}
      <motion.div variants={item} className="space-y-4">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Payment</h2>

        {walletPaySelected ? (
          <div className="space-y-2">
            <div
              className="rounded-lg p-4 flex items-center gap-3"
              style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}
            >
              <Zap size={18} style={{ color: 'var(--primary)' }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Pay with {wallet?.adapter.name ?? 'connected wallet'}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Submitting will prompt {wallet?.adapter.name ?? 'your wallet'} to sign a USDC transfer of <span className="font-mono">${totalCost.toFixed(2)}</span>.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowManualPaste(true)}
              className="text-xs font-mono uppercase tracking-[0.16em] hover:opacity-80 transition-opacity"
              style={{ color: 'var(--text-muted)' }}
            >
              + Send from another wallet (manual paste)
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {!walletConnected && (
              <button
                type="button"
                onClick={() => openWalletModal(true)}
                className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: 'var(--primary)', color: '#fff' }}
              >
                <WalletIcon size={16} />
                Connect wallet to pay automatically
              </button>
            )}
            <Input
              label="Transaction Hash (Solana)"
              placeholder="Enter your Solana transaction hash..."
              value={txHash}
              onChange={e => setTxHash(e.target.value)}
            />
            {walletConnected && showManualPaste && (
              <button
                type="button"
                onClick={() => setShowManualPaste(false)}
                className="text-xs font-mono uppercase tracking-[0.16em] hover:opacity-80 transition-opacity"
                style={{ color: 'var(--primary)' }}
              >
                ← Pay with connected wallet instead
              </button>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Deployment Note (optional)</label>
          <textarea
            className="w-full rounded-lg px-4 py-2.5 transition-colors min-h-[80px] resize-y"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
            }}
            placeholder="Any special instructions or notes..."
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>
      </motion.div>

      {/* Submit */}
      <motion.div variants={item} className="flex justify-end pt-2">
        <Button
          size="lg"
          onClick={handleSubmit}
          loading={submitting}
          disabled={!selectedTier || (!walletPaySelected && !txHash.trim())}
          className="px-8"
        >
          {walletPaySelected ? (
            <>
              <Zap size={16} className="mr-2" />
              {walletPhase === 'signing'
                ? 'Awaiting wallet…'
                : walletPhase === 'submitting'
                  ? 'Submitting…'
                  : `Pay $${totalCost.toFixed(2)} & Deploy`}
            </>
          ) : (
            'Request Deployment'
          )}
        </Button>
      </motion.div>
    </motion.div>
  )
}
