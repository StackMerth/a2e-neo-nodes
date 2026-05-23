'use client'

import { useCallback, useEffect, useState } from 'react'
import { Wallet, Plus, ArrowDownLeft, ArrowUpRight, RefreshCw, AlertCircle, Copy, Check } from 'lucide-react'
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
    if (!txHash.trim() || !Number.isFinite(amountNumber) || amountNumber <= 0) {
      toast('error', 'Enter a transaction hash and the USD amount you sent.')
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
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
          Send USDC to the destination below, then paste the transaction hash.
        </p>

        {destination?.configured && destination.wallet ? (
          <div className="rounded-xl p-4 mb-5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
            <div className="text-[10px] uppercase tracking-[0.18em] font-mono mb-2" style={{ color: 'var(--text-muted)' }}>
              Send {destination.currency} on Solana {destination.network} to
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
            className="rounded-xl p-4 mb-5 flex gap-3"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}
          >
            <AlertCircle size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {destination?.message ?? 'Topup wallet not configured yet. Contact support before sending funds.'}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-mono uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Transaction hash
            </label>
            <input
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="Paste the Solana signature"
              className="w-full rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-[0.16em] mb-1.5" style={{ color: 'var(--text-muted)' }}>
              USD amount sent
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100.00"
              className="w-full rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            />
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
              className="w-full rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !destination?.configured}
            className="px-5 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--primary)', color: '#fff' }}
          >
            {submitting ? 'Verifying...' : 'Credit balance'}
          </button>
        </div>
      </div>
    </div>
  )
}
