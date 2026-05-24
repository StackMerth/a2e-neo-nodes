'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Wallet,
  Plus,
  ArrowDownLeft,
  ArrowUpRight,
  RefreshCw,
  AlertCircle,
  Copy,
  Check,
  X,
  ShieldCheck,
  Zap,
  ExternalLink,
  ArrowRight,
} from 'lucide-react'
import { buyer } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

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
            Pre-load credit, spend it on rentals, no fresh transaction per request.
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

const PRESET_AMOUNTS = [100, 500, 1000, 5000]

function TopupModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (balance: Balance) => void }) {
  const { toast } = useToast()
  const [destination, setDestination] = useState<TopupDestination | null>(null)
  const [txHash, setTxHash] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    buyer.balance
      .topupDestination()
      .then(setDestination)
      .catch((e) => toast('error', e instanceof Error ? e.message : 'Failed to load topup destination'))
  }, [toast])

  async function copyAddress() {
    if (!destination?.wallet) return
    await navigator.clipboard.writeText(destination.wallet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function handleSubmit() {
    const amountNumber = Number(amount)
    if (!txHash.trim()) {
      toast('error', 'Paste the Solana transaction signature first.')
      return
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      toast('error', 'Enter the USD amount you sent.')
      return
    }
    setSubmitting(true)
    try {
      const result = await buyer.balance.topupSolana({
        txHash: txHash.trim(),
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
      setSubmitting(false)
    }
  }

  const networkLabel = destination?.network === 'mainnet' ? 'Solana mainnet' : 'Solana devnet'
  const networkAccent = destination?.network === 'mainnet'
    ? { bg: 'rgba(34,197,94,0.12)', color: 'var(--success)', dot: 'var(--success)' }
    : { bg: 'rgba(245,158,11,0.12)', color: 'var(--warning)', dot: 'var(--warning)' }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-3xl max-h-[92vh] overflow-y-auto relative"
        style={{
          background: 'linear-gradient(180deg, rgba(34,197,94,0.04) 0%, var(--bg-card) 35%, var(--bg-card) 100%)',
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '0 24px 64px -16px rgba(0,0,0,0.6), 0 0 0 1px rgba(34,197,94,0.08), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — large brand icon, eyebrow, title. Close button top-right. */}
        <div className="relative px-6 sm:px-8 pt-7 pb-5">
          <button
            onClick={onClose}
            disabled={submitting}
            className="absolute top-5 right-5 w-9 h-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-50 hover:bg-white/5"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Close"
          >
            <X size={18} />
          </button>

          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, rgba(34,197,94,0.18), rgba(34,197,94,0.06))',
                border: '1px solid rgba(34,197,94,0.25)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 24px rgba(34,197,94,0.18)',
              }}
            >
              <Wallet size={20} style={{ color: 'var(--primary)' }} />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] font-mono" style={{ color: 'var(--text-muted)' }}>
                Add credit
              </div>
              <h2 className="text-2xl font-bold leading-tight" style={{ color: 'var(--text-primary)' }}>
                Top up balance
              </h2>
            </div>
          </div>

          {/* Two-step indicator */}
          <div className="flex items-center gap-3">
            <StepDot index={1} label="Send USDC" />
            <div className="flex-1 h-px" style={{ background: 'linear-gradient(to right, rgba(34,197,94,0.4), rgba(255,255,255,0.06))' }} />
            <StepDot index={2} label="Confirm hash" />
          </div>
        </div>

        <div className="px-6 sm:px-8 pb-7 space-y-5">
          {/* Destination address block */}
          {destination?.configured && destination.wallet ? (
            <div
              className="rounded-2xl p-5"
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[0.18em] font-mono" style={{ color: 'var(--text-muted)' }}>
                    Destination
                  </span>
                </div>
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] uppercase tracking-[0.14em] font-mono"
                  style={{ background: networkAccent.bg, color: networkAccent.color }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{ background: networkAccent.dot }}
                  />
                  {networkLabel}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 text-xs sm:text-sm break-all font-mono leading-relaxed"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {destination.wallet}
                </code>
                <button
                  onClick={copyAddress}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-xs font-medium transition-all hover:bg-white/5"
                  style={{
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.02)',
                    color: copied ? 'var(--success)' : 'var(--text-secondary)',
                  }}
                  title="Copy address"
                >
                  {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                </button>
              </div>
              <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Send <span style={{ color: 'var(--text-secondary)' }}>USDC</span> (SPL Token) to this address from any Solana wallet. Funds usually confirm in {destination.network === 'mainnet' ? '10-30 seconds' : '5-10 seconds'}.
              </p>
            </div>
          ) : (
            <div
              className="rounded-2xl p-5 flex gap-3"
              style={{
                background: 'rgba(245,158,11,0.06)',
                border: '1px solid rgba(245,158,11,0.2)',
              }}
            >
              <AlertCircle size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {destination?.message ?? 'Topup wallet not configured yet. Contact support before sending funds.'}
              </div>
            </div>
          )}

          {/* Form */}
          <div className="space-y-4">
            <FieldBlock label="Amount sent" hint="Match the USD value of the USDC you transferred">
              <div className="relative">
                <span
                  className="absolute left-4 top-1/2 -translate-y-1/2 font-display text-xl pointer-events-none"
                  style={{ color: 'var(--text-muted)' }}
                >
                  $
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-xl pl-10 pr-4 h-14 text-xl font-display tabular-nums outline-none focus:ring-2 focus:ring-offset-0 transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-2 mt-2.5">
                {PRESET_AMOUNTS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setAmount(String(preset))}
                    className="px-3 py-1.5 rounded-full text-xs font-mono transition-colors"
                    style={
                      Number(amount) === preset
                        ? { background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', color: 'var(--primary)' }
                        : { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-muted)' }
                    }
                  >
                    ${preset.toLocaleString()}
                  </button>
                ))}
              </div>
            </FieldBlock>

            <FieldBlock label="Transaction signature" hint="Paste the signature returned by your wallet after sending">
              <input
                type="text"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="e.g. 5VfYx3...8sDe"
                spellCheck={false}
                className="w-full rounded-xl px-4 h-12 text-sm font-mono outline-none transition-all"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}
              />
              {txHash.trim().length > 0 && !txHash.startsWith('DEV_') && (
                <a
                  href={`https://solscan.io/tx/${txHash.trim()}${destination?.network === 'devnet' ? '?cluster=devnet' : ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-[11px] font-mono transition-colors hover:underline"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <ExternalLink size={11} /> View on Solscan
                </a>
              )}
            </FieldBlock>

            <FieldBlock label="Note" hint="Helps you find this credit later in the ledger" optional>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What this topup is for"
                className="w-full rounded-xl px-4 h-12 text-sm outline-none transition-all"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}
              />
            </FieldBlock>
          </div>

          {/* Reassurance row */}
          <div className="grid grid-cols-3 gap-2 pt-1">
            <Reassurance icon={Zap} label="Instant" sub="Credits on confirm" />
            <Reassurance icon={ShieldCheck} label="Idempotent" sub="Resend-safe" />
            <Reassurance icon={Wallet} label="USDC" sub="Solana SPL" />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-5 h-12 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                color: 'var(--text-secondary)',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !destination?.configured}
              className="flex-1 group inline-flex items-center justify-center gap-2 h-12 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: submitting
                  ? 'var(--primary)'
                  : 'linear-gradient(180deg, #2dd271 0%, #1aa055 100%)',
                color: '#0a0a0f',
                boxShadow: '0 1px 0 rgba(255,255,255,0.18) inset, 0 8px 24px -8px rgba(34,197,94,0.55)',
              }}
            >
              {submitting ? (
                <>
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Verifying…
                </>
              ) : (
                <>
                  Credit balance
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function StepDot({ index, label }: { index: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono font-semibold"
        style={{
          background: 'rgba(34,197,94,0.12)',
          border: '1px solid rgba(34,197,94,0.35)',
          color: 'var(--primary)',
        }}
      >
        {index}
      </div>
      <span className="text-[11px] uppercase tracking-[0.16em] font-mono" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
  )
}

function FieldBlock({
  label,
  hint,
  optional,
  children,
}: {
  label: string
  hint?: string
  optional?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <label className="text-[11px] uppercase tracking-[0.16em] font-mono" style={{ color: 'var(--text-secondary)' }}>
          {label}
          {optional && <span className="ml-2 normal-case tracking-normal" style={{ color: 'var(--text-muted)' }}>· optional</span>}
        </label>
        {hint && (
          <span className="text-[10px] font-mono hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

function Reassurance({ icon: Icon, label, sub }: { icon: typeof Wallet; label: string; sub: string }) {
  return (
    <div
      className="rounded-xl px-3 py-2.5 flex items-center gap-2.5"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <Icon size={14} style={{ color: 'var(--primary)' }} />
      <div className="min-w-0">
        <div className="text-[11px] font-semibold leading-tight truncate" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        <div className="text-[10px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </div>
      </div>
    </div>
  )
}
