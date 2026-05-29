'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Search,
  PlusCircle,
  Loader2,
  CheckCircle,
  DollarSign,
  Mail,
  Wallet,
  ChevronRight,
} from 'lucide-react'
import { api } from '@/lib/api'

interface BuyerSummary {
  id: string
  email: string | null
  walletAddress: string | null
  role: string
  isBuyer: boolean
  createdAt: string
  balanceUsd: number
}

interface BalanceTransaction {
  id: string
  type: string
  amountUsd: number
  description: string
  referenceId: string | null
  balanceAfter: number
  createdAt: string
}

interface BalanceSnapshot {
  balanceUsd: number
  totalToppedUp: number
  totalSpent: number
  totalRefunded: number
}

interface UserDetail {
  user: {
    id: string
    email: string | null
    walletAddress: string | null
    role: string
  }
  balance: BalanceSnapshot
  transactions: BalanceTransaction[]
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVar = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

function truncate(s: string | null, n = 10): string {
  if (!s) return '—'
  return s.length > n + 4 ? `${s.slice(0, n)}…${s.slice(-4)}` : s
}

export default function BalanceCreditPage() {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<BuyerSummary[]>([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [amount, setAmount] = useState<string>('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [toastKind, setToastKind] = useState<'ok' | 'err'>('ok')

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true)
    try {
      const res = await api.adminBalance.searchUsers(query.trim() || undefined)
      setUsers(res.users)
    } catch (err) {
      console.error(err)
      setToast('Failed to load users')
      setToastKind('err')
    } finally {
      setLoadingUsers(false)
    }
  }, [query])

  useEffect(() => {
    const t = setTimeout(loadUsers, 250)
    return () => clearTimeout(t)
  }, [loadUsers])

  const loadDetail = useCallback(async (userId: string) => {
    setLoadingDetail(true)
    try {
      const d = await api.adminBalance.get(userId)
      setDetail(d)
    } catch (err) {
      console.error(err)
      setToast('Failed to load user detail')
      setToastKind('err')
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const handleSelect = (id: string) => {
    setSelectedId(id)
    setAmount('')
    setDescription('')
    void loadDetail(id)
  }

  const handleCredit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedId) return
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      setToast('Enter a positive USD amount')
      setToastKind('err')
      return
    }
    if (description.trim().length < 3) {
      setToast('Description is required (3+ chars)')
      setToastKind('err')
      return
    }
    setSubmitting(true)
    try {
      const res = await api.adminBalance.credit({
        userId: selectedId,
        amountUsd: amt,
        description: description.trim(),
      })
      setToast(
        res.duplicate
          ? `Already credited (idempotent retry). New balance: $${res.newBalanceUsd.toFixed(2)}.`
          : `Credited $${amt.toFixed(2)}. New balance: $${res.newBalanceUsd.toFixed(2)}.`,
      )
      setToastKind('ok')
      setAmount('')
      setDescription('')
      await loadDetail(selectedId)
      await loadUsers()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Credit failed'
      setToast(msg)
      setToastKind('err')
    } finally {
      setSubmitting(false)
      setTimeout(() => setToast(null), 6000)
    }
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-6 p-6 max-w-7xl mx-auto"
    >
      <motion.div variants={itemVar}>
        <h1 className="text-3xl font-semibold text-white flex items-center gap-3">
          <PlusCircle className="w-8 h-8 text-emerald-400" />
          Credit Balance
        </h1>
        <p className="text-zinc-400 mt-2 text-sm max-w-2xl">
          Push USD into any buyer's balance with TOPUP_ADMIN. Audited in BalanceTransaction.
          Use for early-tester pre-credits, promo grants, support refunds, and incident make-goods.
          Duplicate clicks are idempotent.
        </p>
      </motion.div>

      {toast && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-lg border px-4 py-3 text-sm ${
            toastKind === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-red-500/40 bg-red-500/10 text-red-200'
          }`}
        >
          {toast}
        </motion.div>
      )}

      <motion.div variants={itemVar} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: user picker */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="text-lg font-medium text-white mb-1">1. Pick a user</h2>
            <p className="text-xs text-zinc-500">
              Search by email, wallet address, or user id. Empty query lists 20 most-recent buyers.
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="email, wallet, or user id"
              className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-white text-sm placeholder-zinc-500 focus:border-emerald-500/50 focus:outline-none"
            />
          </div>
          <div className="max-h-[460px] overflow-y-auto -mx-1 space-y-1 pr-1">
            {loadingUsers ? (
              <div className="flex items-center justify-center py-12 text-zinc-500 text-sm">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading…
              </div>
            ) : users.length === 0 ? (
              <div className="text-center py-12 text-zinc-500 text-sm">No users found.</div>
            ) : (
              users.map((u) => (
                <button
                  key={u.id}
                  onClick={() => handleSelect(u.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors flex items-center justify-between ${
                    selectedId === u.id
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-zinc-800 hover:border-zinc-700 bg-zinc-950/50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-white truncate flex items-center gap-2">
                      {u.email ? (
                        <>
                          <Mail className="w-3 h-3 text-zinc-500 shrink-0" />
                          <span className="truncate">{u.email}</span>
                        </>
                      ) : u.walletAddress ? (
                        <>
                          <Wallet className="w-3 h-3 text-zinc-500 shrink-0" />
                          <span className="truncate font-mono">{truncate(u.walletAddress, 12)}</span>
                        </>
                      ) : (
                        <span className="text-zinc-500">{truncate(u.id)}</span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {u.role} · created {new Date(u.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="text-sm text-emerald-300 font-medium">
                      ${u.balanceUsd.toFixed(2)}
                    </div>
                    <ChevronRight className="w-4 h-4 text-zinc-600 inline-block" />
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* RIGHT: credit form + detail */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-5">
          <div>
            <h2 className="text-lg font-medium text-white mb-1">2. Credit the balance</h2>
            <p className="text-xs text-zinc-500">
              Writes a TOPUP_ADMIN BalanceTransaction. The description is shown to the user
              in their balance history, so keep it human ("Pre-credit for closed beta").
            </p>
          </div>

          {!selectedId ? (
            <div className="rounded-lg border border-zinc-800 border-dashed py-16 text-center text-zinc-500 text-sm">
              Select a user on the left to begin.
            </div>
          ) : loadingDetail || !detail ? (
            <div className="flex items-center justify-center py-12 text-zinc-500 text-sm">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading user…
            </div>
          ) : (
            <>
              {/* Selected user summary */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-zinc-500">Selected user</div>
                  <div className="text-xs text-zinc-500 font-mono">{detail.user.id}</div>
                </div>
                <div className="text-sm text-white">
                  {detail.user.email ?? <span className="text-zinc-500">no email</span>}
                </div>
                <div className="text-xs text-zinc-400 font-mono">
                  {detail.user.walletAddress ?? 'no wallet'}
                </div>
              </div>

              {/* Balance summary */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <div className="text-xs text-zinc-500">Current balance</div>
                  <div className="text-2xl text-emerald-300 font-semibold mt-1">
                    ${detail.balance.balanceUsd.toFixed(2)}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                  <div className="text-xs text-zinc-500">Total topped-up</div>
                  <div className="text-2xl text-white font-semibold mt-1">
                    ${detail.balance.totalToppedUp.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* Credit form */}
              <form onSubmit={handleCredit} className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Amount (USD)</label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100000"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="300.00"
                      className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-white focus:border-emerald-500/50 focus:outline-none"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-1 block">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Pre-credit for closed beta tester"
                    rows={2}
                    minLength={3}
                    maxLength={280}
                    className="w-full px-4 py-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-600 text-sm focus:border-emerald-500/50 focus:outline-none resize-none"
                    required
                  />
                  <div className="text-xs text-zinc-500 mt-1">
                    Shown in the user's balance history. {description.length}/280.
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={submitting || !amount || description.trim().length < 3}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-200 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" /> Crediting…
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4" /> Credit ${amount || '0.00'}
                    </>
                  )}
                </button>
              </form>

              {/* Recent transactions */}
              <div className="border-t border-zinc-800 pt-4">
                <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                  Recent transactions
                </div>
                {detail.transactions.length === 0 ? (
                  <div className="text-xs text-zinc-500 py-4">No transactions yet.</div>
                ) : (
                  <div className="space-y-1 max-h-64 overflow-y-auto -mr-2 pr-2">
                    {detail.transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="flex items-center justify-between text-xs py-2 border-b border-zinc-800/50 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <div className="text-zinc-300 font-mono">{tx.type}</div>
                          <div className="text-zinc-500 truncate max-w-[20rem]">
                            {tx.description}
                          </div>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <div
                            className={
                              tx.amountUsd >= 0 ? 'text-emerald-300' : 'text-red-300'
                            }
                          >
                            {tx.amountUsd >= 0 ? '+' : ''}${tx.amountUsd.toFixed(2)}
                          </div>
                          <div className="text-zinc-600">
                            {new Date(tx.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
