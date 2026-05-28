'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Rocket, CircleCheck, Hash, Wallet as WalletIcon, Zap, CreditCard, Copy, PiggyBank } from 'lucide-react'
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

  // Payment method picker. Three mutually-exclusive choices replace the
  // old "three same-sized buttons" cluster. The submit button at the
  // bottom routes to the matching handler.
  type PaymentMethod = 'wallet' | 'card' | 'balance'
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('wallet')

  // Pay-from-balance path. Loads the operator's current credit balance
  // so we can show the picker only when it's usable (>0) and gate
  // submission on sufficient balance for the selected total cost.
  const [buyerBalanceUsd, setBuyerBalanceUsd] = useState<number>(0)
  useEffect(() => {
    let cancelled = false
    buyer.balance.get()
      .then((r) => { if (!cancelled) setBuyerBalanceUsd(r.balanceUsd) })
      .catch(() => { /* hide the picker silently on error */ })
    return () => { cancelled = true }
  }, [])
  const balanceShort = buyerBalanceUsd < totalCost
  const [balanceSubmitting, setBalanceSubmitting] = useState(false)
  async function handlePayFromBalance() {
    if (!selectedTier) { toast('error', 'Please select a GPU tier'); return }
    if (balanceShort) {
      toast('error', `Need $${totalCost.toFixed(2)}, have $${buyerBalanceUsd.toFixed(2)}. Top up first.`)
      return
    }
    setBalanceSubmitting(true)
    try {
      const result = await nodeRunner.deploy({
        gpuTier: selectedTier,
        nodeCount,
        paymentSource: 'BUYER_BALANCE',
        deploymentNote: note.trim() || undefined,
      }) as { id: string }
      toast('success', 'Paid from balance. Tracking your deployment now.')
      router.push(`/deployments/${result.id}`)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setBalanceSubmitting(false)
    }
  }

  // Stripe card-payment path: redirect to Hosted Checkout. The
  // webhook creates the Investment row server-side once Stripe confirms
  // payment, so a cancelled checkout leaves nothing to clean up.
  const [cardSubmitting, setCardSubmitting] = useState(false)
  async function handlePayWithCard() {
    if (!selectedTier) {
      toast('error', 'Please select a GPU tier')
      return
    }
    setCardSubmitting(true)
    try {
      const { url } = await nodeRunner.deployStripeCheckout({
        gpuTier: selectedTier,
        nodeCount,
        deploymentNote: note.trim() || undefined,
      })
      window.location.href = url
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start card payment'
      toast('error', msg)
      setCardSubmitting(false)
    }
  }

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
      const result = await nodeRunner.deploy({
        gpuTier: selectedTier,
        nodeCount,
        txHash: resolvedTxHash,
        deploymentNote: note.trim() || undefined,
      }) as { id: string }
      toast('success', 'Payment confirmed. Tracking your deployment now.')
      // Jump directly to the deployment detail page so the operator
      // sees the auto-minted curl one-liner without having to find
      // it in the deployments list.
      router.push(`/deployments/${result.id}`)
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

      {/* Payment — three mutually-exclusive method cards at the top
          control the picker; the inline form below adapts to the
          selected method, and a single submit button at the bottom
          fires the matching handler. Replaces a stacked three-equal-
          buttons cluster that read as ambiguous. */}
      <motion.div variants={item} className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Payment method</h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Pick how you&rsquo;d like to pay. You can switch any time before submitting.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Wallet card */}
          <button
            type="button"
            onClick={() => setPaymentMethod('wallet')}
            className="text-left rounded-xl p-4 transition-all duration-200 relative"
            style={paymentMethod === 'wallet'
              ? { background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.5)', boxShadow: '0 0 18px rgba(34,197,94,0.18)' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
            }
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Wallet</span>
              <Zap size={16} style={{ color: 'var(--primary)' }} />
            </div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {walletConnected ? `Sign with ${wallet?.adapter.name ?? 'connected wallet'}` : 'Phantom / Solflare USDC'}
            </p>
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>Instant, on-chain</p>
            {paymentMethod === 'wallet' && (
              <div className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ background: 'var(--primary)' }} />
            )}
          </button>

          {/* Card card */}
          <button
            type="button"
            onClick={() => setPaymentMethod('card')}
            className="text-left rounded-xl p-4 transition-all duration-200 relative"
            style={paymentMethod === 'card'
              ? { background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.5)', boxShadow: '0 0 18px rgba(59,130,246,0.18)' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
            }
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Card</span>
              <CreditCard size={16} style={{ color: 'var(--info)' }} />
            </div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Pay with any debit or credit card</p>
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>Via Stripe Hosted Checkout</p>
            {paymentMethod === 'card' && (
              <div className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ background: 'var(--info)' }} />
            )}
          </button>

          {/* Balance card */}
          {(() => {
            const balanceDisabled = buyerBalanceUsd === 0 || balanceShort
            return (
              <button
                type="button"
                onClick={() => { if (!balanceDisabled) setPaymentMethod('balance') }}
                disabled={balanceDisabled}
                className="text-left rounded-xl p-4 transition-all duration-200 relative disabled:cursor-not-allowed"
                style={paymentMethod === 'balance'
                  ? { background: 'rgba(168,85,247,0.10)', border: '1px solid rgba(168,85,247,0.5)', boxShadow: '0 0 18px rgba(168,85,247,0.18)' }
                  : balanceDisabled
                    ? { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', opacity: 0.55 }
                    : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                }
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Balance</span>
                  <PiggyBank size={16} style={{ color: '#a855f7' }} />
                </div>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {buyerBalanceUsd === 0
                    ? 'Top up first to enable'
                    : balanceShort
                      ? `Short by $${(totalCost - buyerBalanceUsd).toFixed(2)}`
                      : `$${buyerBalanceUsd.toFixed(2)} available`}
                </p>
                <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                  {balanceDisabled ? ' ' : 'No transaction'}
                </p>
                {paymentMethod === 'balance' && (
                  <div className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full" style={{ background: '#a855f7' }} />
                )}
              </button>
            )
          })()}
        </div>

        {paymentMethod === 'card' && (
          <div
            className="rounded-lg p-4 flex items-start gap-3"
            style={{ background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.20)' }}
          >
            <CreditCard size={18} style={{ color: 'var(--info)', marginTop: 2 }} />
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                You&rsquo;ll be redirected to Stripe to pay <span className="font-mono">${totalCost.toFixed(2)}</span>.
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Card details never touch our servers. After payment confirms you&rsquo;ll be brought back to your deployment page.
              </p>
            </div>
          </div>
        )}

        {paymentMethod === 'balance' && !balanceShort && buyerBalanceUsd > 0 && (
          <div
            className="rounded-lg p-4 space-y-2 text-sm"
            style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.20)' }}
          >
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>Balance before</span>
              <span className="font-mono" style={{ color: 'var(--text-primary)' }}>${buyerBalanceUsd.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>This deployment</span>
              <span className="font-mono" style={{ color: '#ef4444' }}>&minus;${totalCost.toFixed(2)}</span>
            </div>
            <div className="flex justify-between pt-2" style={{ borderTop: '1px solid var(--border-color)' }}>
              <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Balance after</span>
              <span className="font-mono font-semibold" style={{ color: '#a855f7' }}>${(buyerBalanceUsd - totalCost).toFixed(2)}</span>
            </div>
          </div>
        )}

        {paymentMethod === 'wallet' && (
          walletPaySelected ? (
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
              className="text-sm font-medium hover:opacity-80 transition-opacity underline underline-offset-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              Send from another wallet instead
            </button>
          </div>
        ) : (
          <div className="space-y-3">
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
            {topupDestination?.configured && topupDestination.wallet ? (
              <div
                className="rounded-lg p-4 space-y-3"
                style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.25)' }}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-mono uppercase tracking-[0.16em] font-semibold" style={{ color: 'var(--primary)' }}>
                    Send USDC to this address
                  </p>
                  <span
                    className="text-[10px] font-mono uppercase tracking-[0.16em] px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                  >
                    Solana {topupDestination.network}
                  </span>
                </div>
                <div className="flex items-stretch gap-2">
                  <code
                    className="flex-1 min-w-0 text-xs font-mono break-all px-3 py-2.5 rounded-md"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                  >
                    {topupDestination.wallet}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(topupDestination.wallet!)
                      toast('success', 'Address copied')
                    }}
                    className="inline-flex items-center gap-1.5 px-3 rounded-md text-xs font-semibold hover:opacity-90 transition-opacity"
                    style={{ background: 'var(--primary)', color: '#fff' }}
                  >
                    <Copy size={14} />
                    Copy
                  </button>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Send exactly{' '}
                  <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                    ${totalCost.toFixed(2)} USDC
                  </span>{' '}
                  to the address above, then paste the resulting transaction signature below. The wrong amount or address will fail to credit your deployment.
                </p>
              </div>
            ) : (
              <div
                className="rounded-lg p-3 text-xs"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: 'var(--warning)' }}
              >
                Topup destination is not configured. Contact support before paying.
              </div>
            )}
            <Input
              label="Transaction Hash (Solana)"
              placeholder="Paste the Solana transaction signature..."
              value={txHash}
              onChange={e => setTxHash(e.target.value)}
            />
            {walletConnected && showManualPaste && (
              <button
                type="button"
                onClick={() => setShowManualPaste(false)}
                className="text-sm font-medium hover:opacity-80 transition-opacity underline underline-offset-4"
                style={{ color: 'var(--primary)' }}
              >
                ← Pay with connected wallet instead
              </button>
            )}
          </div>
        ))}

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

      {/* Single submit button — routes to the handler matching the
          selected payment method. Label + icon + disabled state all
          adapt so the operator sees exactly what will happen. Replaces
          a stacked three-equal-button cluster. */}
      <motion.div variants={item} className="flex justify-end pt-2">
        <Button
          size="lg"
          onClick={() => {
            if (paymentMethod === 'card') handlePayWithCard()
            else if (paymentMethod === 'balance') handlePayFromBalance()
            else handleSubmit()
          }}
          loading={submitting || cardSubmitting || balanceSubmitting}
          disabled={
            !selectedTier ||
            (paymentMethod === 'wallet' && !walletPaySelected && !txHash.trim()) ||
            (paymentMethod === 'balance' && (buyerBalanceUsd === 0 || balanceShort))
          }
          className="w-full sm:w-auto px-10 h-14 text-base"
        >
          {paymentMethod === 'card' ? (
            <>
              <CreditCard size={18} className="mr-2" />
              {cardSubmitting ? 'Redirecting to Stripe…' : `Pay $${totalCost.toFixed(2)} with card`}
            </>
          ) : paymentMethod === 'balance' ? (
            <>
              <PiggyBank size={18} className="mr-2" />
              {balanceSubmitting ? 'Charging balance…' : `Pay $${totalCost.toFixed(2)} from balance`}
            </>
          ) : walletPaySelected ? (
            <>
              <Zap size={18} className="mr-2" />
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
