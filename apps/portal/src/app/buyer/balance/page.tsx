'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Wallet, Plus, ArrowDownLeft, ArrowUpRight, RefreshCw, AlertCircle, Copy, Check, Zap, ExternalLink, Loader2, CreditCard } from 'lucide-react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { buyer } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { useUsdcPayment } from '@/hooks/useUsdcPayment'

interface Balance {
  balanceUsd: number
  totalToppedUp: number
  totalSpent: number
  totalRefunded: number
}

interface Tx {
  id: string
  type: string
  amountUsd: number
  description: string
  referenceId: string | null
  balanceAfter: number
  createdAt: string
}

interface TopupDestination {
  wallet: string | null
  currency: 'USDC'
  network: 'devnet' | 'mainnet'
  configured: boolean
  message?: string
}

/**
 * Normalize a user-pasted Solana transaction reference into the bare
 * base58 signature the RPC expects. Handles:
 *   - Solscan URLs: https://solscan.io/tx/<sig>?...
 *   - Solana Explorer: https://explorer.solana.com/tx/<sig>?cluster=...
 *   - SolanaFM: https://solana.fm/tx/<sig>
 *   - XRAY: https://xray.helius.xyz/tx/<sig>
 *   - bare signature: <sig>
 * Strips trailing slashes, query strings, and fragments.
 */
function extractTxSignature(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const txMatch = trimmed.match(/\/(?:tx|transaction)\/([1-9A-HJ-NP-Za-km-z]+)/)
  if (txMatch) return txMatch[1]!
  return trimmed.split(/[?#]/)[0]!.replace(/\/+$/, '')
}

const TX_TYPE_META: Record<string, { label: string; tone: 'credit' | 'debit'; icon: typeof ArrowDownLeft }> = {
  TOPUP_SOLANA: { label: 'Solana topup', tone: 'credit', icon: ArrowDownLeft },
  TOPUP_STRIPE: { label: 'Card topup', tone: 'credit', icon: ArrowDownLeft },
  TOPUP_ADMIN: { label: 'Admin credit', tone: 'credit', icon: ArrowDownLeft },
  SPEND_RENTAL: { label: 'Rental', tone: 'debit', icon: ArrowUpRight },
  REFUND_RENTAL: { label: 'Rental refund', tone: 'credit', icon: ArrowDownLeft },
  REFUND_FAILED: { label: 'Failed-allocation refund', tone: 'credit', icon: ArrowDownLeft },
}

export default function BalancePage() {
  const { toast } = useToast()
  const [balance, setBalance] = useState<Balance | null>(null)
  const [txs, setTxs] = useState<Tx[]>([])
  const [loading, setLoading] = useState(true)
  const [topupOpen, setTopupOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [b, t] = await Promise.all([buyer.balance.get(), buyer.balance.transactions(50)])
      setBalance(b)
      setTxs(t.transactions)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load balance')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  function handleTopupSuccess(newBalance: Balance) {
    setBalance(newBalance)
    setTopupOpen(false)
    void load()
  }

  if (loading && !balance) {
    return (
      <div className="space-y-6">
        <div className="h-32 rounded-2xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        <div className="h-64 rounded-2xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-3" style={{ color: 'var(--text-primary)' }}>
            <Wallet size={28} style={{ color: 'var(--primary)' }} />
            Balance
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            Pre-load credit, spend it on rentals or node deployments, no fresh transaction per request.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-lg transition-colors"
            style={{ border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}
            title="Refresh"
          >
            <RefreshCw size={16} style={{ color: 'var(--text-secondary)' }} />
          </button>
          <button
            onClick={() => setTopupOpen(true)}
            className="px-4 py-2 rounded-lg font-semibold text-sm transition-all hover:opacity-90"
            style={{ background: 'var(--primary)', color: '#fff', boxShadow: '0 0 12px rgba(34,197,94,0.25)' }}
          >
            <Plus size={16} className="inline mr-1.5 -mt-0.5" />
            Top up
          </button>
        </div>
      </div>

      {/* Headline balance + stats */}
      <div
        className="rounded-2xl p-6 sm:p-8"
        style={{
          background: 'linear-gradient(to bottom right, rgba(34,197,94,0.08), rgba(34,197,94,0.01) 60%, transparent)',
          border: '1px solid rgba(34, 197, 94, 0.2)',
        }}
      >
        <div className="text-xs uppercase tracking-[0.18em] font-mono mb-2" style={{ color: 'var(--text-muted)' }}>
          Available balance
        </div>
        <div className="text-4xl sm:text-6xl font-bold mb-6" style={{ color: 'var(--text-primary)' }}>
          ${(balance?.balanceUsd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className="grid grid-cols-3 gap-3 sm:gap-6">
          <SummaryStat label="Lifetime topped up" amount={balance?.totalToppedUp ?? 0} tone="muted" />
          <SummaryStat label="Lifetime spent" amount={balance?.totalSpent ?? 0} tone="muted" />
          <SummaryStat label="Refunded back" amount={balance?.totalRefunded ?? 0} tone="muted" />
        </div>
      </div>

      {/* Transactions */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-color)' }}>
          <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Transactions</h2>
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {txs.length} {txs.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        {txs.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3" style={{ background: 'var(--bg-elevated)' }}>
              <Wallet size={20} style={{ color: 'var(--text-muted)' }} />
            </div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No transactions yet. Top up your balance to get started.
            </p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border-color)' }}>
            {txs.map((tx) => {
              const meta = TX_TYPE_META[tx.type] ?? { label: tx.type, tone: 'debit' as const, icon: ArrowUpRight }
              const Icon = meta.icon
              const isCredit = meta.tone === 'credit'
              return (
                <div key={tx.id} className="px-5 py-3.5 flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
                  <div
                    className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
                    style={{
                      background: isCredit ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.10)',
                      color: isCredit ? 'var(--success)' : 'var(--danger)',
                    }}
                  >
                    <Icon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {meta.label}
                    </div>
                    <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      {tx.description}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold tabular-nums" style={{ color: isCredit ? 'var(--success)' : 'var(--text-primary)' }}>
                      {tx.amountUsd >= 0 ? '+' : ''}${Math.abs(tx.amountUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                      bal ${tx.balanceAfter.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {topupOpen && <TopupModal onClose={() => setTopupOpen(false)} onSuccess={handleTopupSuccess} />}
    </div>
  )
}

function SummaryStat({ label, amount, tone }: { label: string; amount: number; tone: 'muted' | 'brand' }) {
  return (
    <div>
      <div className="text-[10px] sm:text-xs uppercase tracking-[0.16em] font-mono mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div
        className="text-base sm:text-xl font-semibold tabular-nums"
        style={{ color: tone === 'brand' ? 'var(--primary)' : 'var(--text-primary)' }}
      >
        ${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </div>
    </div>
  )
}

const PRESET_AMOUNTS = [50, 100, 500, 1000]

type Phase = 'idle' | 'awaiting-signature' | 'confirming' | 'crediting'

function TopupModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (balance: Balance) => void }) {
  const { toast } = useToast()
  const { publicKey, wallet } = useWallet()
  const { setVisible: openWalletModal } = useWalletModal()
  const { pay, network: walletNetwork } = useUsdcPayment()

  const [destination, setDestination] = useState<TopupDestination | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)

  // Wallet-pay state
  const [phase, setPhase] = useState<Phase>('idle')
  const [completedTx, setCompletedTx] = useState<string | null>(null)

  // Manual-paste fallback (collapsed by default when a wallet is
  // connected; shown by default when no wallet is present).
  const [showManual, setShowManual] = useState(false)
  const [manualTxHash, setManualTxHash] = useState('')
  const [manualSubmitting, setManualSubmitting] = useState(false)

  useEffect(() => {
    buyer.balance
      .topupDestination()
      .then(setDestination)
      .catch((e) => toast('error', e instanceof Error ? e.message : 'Failed to load topup destination'))
  }, [toast])

  // If no wallet is connected, manual paste becomes the primary path
  // (the Connect Wallet CTA still shows above it but the paste form
  // is expanded so first-time visitors see the fallback immediately).
  useEffect(() => {
    if (!publicKey) setShowManual(true)
  }, [publicKey])

  async function copyAddress() {
    if (!destination?.wallet) return
    await navigator.clipboard.writeText(destination.wallet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Wallet-pay flow: sign in wallet -> await chain confirmation ->
  // POST the signature to the existing topup-solana endpoint -> show
  // success state with a Solscan link.
  async function handleWalletPay() {
    const amountNumber = Number(amount)
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      toast('error', 'Enter the USD amount you want to topup.')
      return
    }
    if (!destination?.configured || !destination.wallet) {
      toast('error', destination?.message ?? 'Topup destination not configured.')
      return
    }
    if (!publicKey) {
      openWalletModal(true)
      return
    }

    setCompletedTx(null)
    try {
      setPhase('awaiting-signature')
      // sendTransaction in the hook handles signature + confirmation
      // in one call. The internal state on the hook tracks submitting,
      // but we want to surface our own phase strings here.
      const { signature } = await pay({
        recipient: destination.wallet,
        amountUsd: amountNumber,
      })
      setPhase('crediting')
      const result = await buyer.balance.topupSolana({
        txHash: signature,
        amountUsd: amountNumber,
        note: note.trim() || undefined,
      })
      if (result.alreadyCredited) {
        toast('info', 'This transaction was already credited.')
      } else {
        toast('success', `Credited $${result.creditedUsd?.toFixed(2)} to your balance.`)
      }
      setCompletedTx(signature)
      onSuccess(result.balance)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Payment failed'
      // Common wallet-side rejection: surface a friendlier copy.
      if (msg.toLowerCase().includes('user rejected')) {
        toast('error', 'Cancelled in your wallet.')
      } else {
        toast('error', msg)
      }
      setPhase('idle')
    }
  }

  async function handleManualPaste() {
    const amountNumber = Number(amount)
    if (!manualTxHash.trim() || !Number.isFinite(amountNumber) || amountNumber <= 0) {
      toast('error', 'Enter a transaction hash and the USD amount you sent.')
      return
    }
    // Buyers often copy from Solscan / Solana Explorer / SolanaFM and the
    // full URL comes along ("https://solscan.io/tx/<sig>"). The RPC needs
    // just the base58 signature or it returns "Invalid param: WrongSize".
    // Extract the path segment after /tx/ or /transaction/, then strip
    // any query string / fragment / trailing slash. Bare-hash paste also
    // passes through unchanged.
    const normalizedTxHash = extractTxSignature(manualTxHash)
    setManualSubmitting(true)
    try {
      const result = await buyer.balance.topupSolana({
        txHash: normalizedTxHash,
        amountUsd: amountNumber,
        note: note.trim() || undefined,
      })
      if (result.alreadyCredited) {
        toast('info', 'This transaction was already credited.')
      } else {
        toast('success', `Credited $${result.creditedUsd?.toFixed(2)} to your balance.`)
      }
      onSuccess(result.balance)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Topup failed')
    } finally {
      setManualSubmitting(false)
    }
  }

  // Fiat onramp: hand the buyer off to Stripe Hosted Checkout. The
  // balance credit happens later via the /v1/webhooks/stripe handler
  // when Stripe confirms payment, so no UI work needed here beyond
  // the redirect — the balance page re-fetches state on mount when
  // Stripe sends the buyer back to ?topup=success.
  const [cardSubmitting, setCardSubmitting] = useState(false)
  async function handlePayWithCard() {
    const amountNumber = Number(amount)
    if (!Number.isFinite(amountNumber) || amountNumber < 1) {
      toast('error', 'Enter at least $1 to top up with a card.')
      return
    }
    setCardSubmitting(true)
    try {
      const { url } = await buyer.balance.topupStripeCheckout({ amountUsd: amountNumber })
      window.location.href = url
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start card checkout'
      // 503 from the API means STRIPE_SECRET_KEY isn't set on Render.
      // Surface a clean message rather than the raw error string.
      if (msg.includes('not_configured') || msg.toLowerCase().includes('not enabled')) {
        toast('error', 'Card topup is not enabled on this deploy yet.')
      } else {
        toast('error', msg)
      }
      setCardSubmitting(false)
    }
  }

  const phaseLabel = (() => {
    switch (phase) {
      case 'awaiting-signature':
        return 'Awaiting wallet signature…'
      case 'confirming':
        return 'Confirming on Solana…'
      case 'crediting':
        return 'Crediting your balance…'
      default:
        return null
    }
  })()

  const walletConnected = !!publicKey
  const walletAddr = publicKey?.toBase58() ?? ''
  const walletShort = walletAddr ? `${walletAddr.slice(0, 4)}…${walletAddr.slice(-4)}` : ''
  const networkLabel = destination?.network === 'mainnet' ? 'Solana mainnet' : 'Solana devnet'
  // Note: we intentionally do NOT block on the wallet's UI network
  // setting. The wallet-adapter ConnectionProvider drives which RPC
  // any signed tx hits — the wallet's own "network" toggle is
  // cosmetic for this dApp's flows. A previous version warned about
  // a "mismatch" here, but the mismatch detection was bogus (both
  // sides read from the same env var) so it never fired anyway.
  // Re-introduce only if we add a real wallet-side network probe.

  // Render via React Portal to document.body so the modal escapes any
  // parent stacking context (page wrapper, sidebar transforms, etc).
  // Without the portal, the TopHeader's backdrop-filter creates a
  // sibling stacking context that the modal's z-index can lose to
  // depending on layout nesting. SSR-safe: typeof document guard.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{
        // z-index 9999 is intentionally absurd: guarantees the modal
        // wins against any other fixed/portal layer (TopHeader z-30,
        // toasts z-9999 from the Toast provider — toasts will still
        // win because they share this z + render later, which is the
        // intended UX).
        zIndex: 9999,
        // 95% opacity backdrop + 16px blur completely obscures
        // anything behind so the TopHeader, sidebar, and page content
        // all disappear behind the modal.
        background: 'rgba(0,0,0,0.95)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl p-6 sm:p-7 max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          Top up balance
        </h2>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
          {walletConnected
            ? 'Sign a USDC transfer in your wallet and your balance credits automatically.'
            : 'Connect a Solana wallet to sign-to-pay, or send manually and paste the transaction hash.'}
        </p>

        {/* Success state after a wallet pay confirms */}
        {completedTx && (
          <div
            className="rounded-xl p-4 mb-5 flex items-start gap-3"
            style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)' }}
          >
            <Check size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--success)' }} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                Balance credited
              </div>
              <a
                href={`https://solscan.io/tx/${completedTx}${destination?.network === 'devnet' ? '?cluster=devnet' : ''}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-mono break-all hover:underline"
                style={{ color: 'var(--text-muted)' }}
              >
                {completedTx.slice(0, 12)}…{completedTx.slice(-8)}
                <ExternalLink size={11} />
              </a>
            </div>
          </div>
        )}

        {/* Amount + note inputs (shared between both paths) */}
        <div className="space-y-4 mb-5">
          <div>
            <label className="block text-xs font-mono uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--text-muted)' }}>
              USD amount
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100.00"
              disabled={phase !== 'idle'}
              className="w-full rounded-lg px-3 py-2.5 text-base font-semibold tabular-nums"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {PRESET_AMOUNTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(String(p))}
                  disabled={phase !== 'idle'}
                  className="px-3 py-1 rounded-full text-xs font-mono transition-colors"
                  style={Number(amount) === p
                    ? { background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', color: 'var(--primary)' }
                    : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }
                  }
                >
                  ${p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Note (optional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What this topup is for"
              disabled={phase !== 'idle'}
              className="w-full rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        {/* Primary action: sign-to-pay (wallet connected) OR connect (not connected) */}
        {walletConnected ? (
          <button
            onClick={handleWalletPay}
            disabled={phase !== 'idle' || !destination?.configured}
            className="w-full inline-flex items-center justify-center gap-2 h-12 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'var(--primary)', color: '#fff' }}
          >
            {phase !== 'idle' ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {phaseLabel}
              </>
            ) : (
              <>
                <Zap size={16} />
                Pay ${Number(amount || 0).toFixed(2)} with {wallet?.adapter.name ?? 'wallet'} ({walletShort})
              </>
            )}
          </button>
        ) : (
          <button
            onClick={() => openWalletModal(true)}
            className="w-full inline-flex items-center justify-center gap-2 h-12 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
            style={{ background: 'var(--primary)', color: '#fff' }}
          >
            <Wallet size={16} />
            Connect wallet to pay
          </button>
        )}

        {/* Pay-with-card option — Stripe Hosted Checkout. Sits as a
            secondary CTA below the wallet/connect primary so the
            crypto path stays the default for users who have a wallet
            connected, while still giving non-crypto buyers a clear
            on-ramp. */}
        <button
          onClick={handlePayWithCard}
          disabled={cardSubmitting || Number(amount || 0) < 1}
          className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed mt-3"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
          }}
        >
          {cardSubmitting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Opening Stripe…
            </>
          ) : (
            <>
              <CreditCard size={14} />
              Pay ${Number(amount || 0).toFixed(2)} with card (Stripe)
            </>
          )}
        </button>

        {/* Manual paste fallback — collapsible */}
        <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--border-color)' }}>
          <button
            type="button"
            onClick={() => setShowManual((s) => !s)}
            className="text-xs font-mono uppercase tracking-[0.16em] hover:opacity-80 transition-opacity"
            style={{ color: 'var(--text-muted)' }}
          >
            {showManual ? '− Hide manual paste' : '+ Send from another wallet (manual paste)'}
          </button>

          {showManual && (
            <div className="mt-4 space-y-4">
              {destination?.configured && destination.wallet ? (
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                  <div className="text-[10px] uppercase tracking-[0.18em] font-mono mb-2" style={{ color: 'var(--text-muted)' }}>
                    Send {destination.currency} on {networkLabel} to
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs break-all" style={{ color: 'var(--text-primary)' }}>{destination.wallet}</code>
                    <button
                      onClick={copyAddress}
                      className="shrink-0 p-2 rounded-lg transition-colors"
                      style={{ border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}
                      title="Copy address"
                    >
                      {copied ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} style={{ color: 'var(--text-secondary)' }} />}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-xl p-3 flex gap-3"
                  style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}
                >
                  <AlertCircle size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {destination?.message ?? 'Topup wallet not configured yet. Contact support.'}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs font-mono uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  Transaction hash
                </label>
                <input
                  type="text"
                  value={manualTxHash}
                  onChange={(e) => setManualTxHash(e.target.value)}
                  placeholder="Paste the signature or the Solscan / Explorer URL"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
                />
              </div>
              <button
                onClick={handleManualPaste}
                disabled={manualSubmitting || !destination?.configured}
                className="w-full px-5 h-11 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
              >
                {manualSubmitting ? 'Verifying…' : 'Credit balance from manual paste'}
              </button>
            </div>
          )}
        </div>

        <div className="flex justify-end mt-5">
          <button
            onClick={onClose}
            disabled={phase !== 'idle'}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
          >
            {completedTx ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>,
    document.body, // portal target
  )
}
