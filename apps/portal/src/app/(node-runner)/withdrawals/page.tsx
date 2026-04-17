'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Wallet,
  ExternalLink,
  CircleCheck,
  Clock,
  Loader2,
  CircleX,
  ArrowDownToLine,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'

/* -----------------------------------------------
   Types
   ----------------------------------------------- */

interface WithdrawalBalance {
  totalEarnings: number
  completedWithdrawals: number
  pendingWithdrawals: number
  availableBalance: number
}

interface Withdrawal {
  id: string
  amount: number
  walletAddress: string
  status: string
  txHash: string | null
  createdAt: string
  processedAt: string | null
}

interface WithdrawalListData {
  withdrawals: Withdrawal[]
  total: number
  page: number
  limit: number
  pages: number
}

/* -----------------------------------------------
   Animation Variants
   ----------------------------------------------- */

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

/* -----------------------------------------------
   Status Config
   ----------------------------------------------- */

const statusConfig: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
  PENDING: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: <Clock size={12} /> },
  APPROVED: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', icon: <ShieldCheck size={12} /> },
  PROCESSING: { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6', icon: <Loader2 size={12} className="animate-spin" /> },
  COMPLETED: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', icon: <CircleCheck size={12} /> },
  REJECTED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: <CircleX size={12} /> },
}

/* -----------------------------------------------
   Helpers
   ----------------------------------------------- */

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)

/* -----------------------------------------------
   Page Component
   ----------------------------------------------- */

export default function WithdrawalsPage() {
  const { user } = useAuth()
  const [balance, setBalance] = useState<WithdrawalBalance | null>(null)
  const [data, setData] = useState<WithdrawalListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitSuccess, setSubmitSuccess] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const [balanceRes, listRes] = await Promise.all([
        nodeRunner.withdrawalBalance() as Promise<WithdrawalBalance>,
        nodeRunner.withdrawals({ page: String(page), limit: '20' }) as Promise<WithdrawalListData>,
      ])
      setBalance(balanceRes)
      setData(listRes)
    } catch {
      /* silently fail */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page])

  useEffect(() => {
    loadData()
  }, [loadData])

  const openModal = () => {
    setAmount('')
    setWalletAddress(user?.walletAddress || '')
    setSubmitError('')
    setSubmitSuccess(false)
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    setSubmitError('')
    const amountNum = parseFloat(amount)

    if (!amountNum || amountNum <= 0) {
      setSubmitError('Please enter a valid amount')
      return
    }
    if (balance && amountNum > balance.availableBalance) {
      setSubmitError('Amount exceeds available balance')
      return
    }
    if (!walletAddress.trim()) {
      setSubmitError('Wallet address is required')
      return
    }

    setSubmitting(true)
    try {
      await nodeRunner.requestWithdrawal({
        amount: amountNum,
        walletAddress: walletAddress.trim(),
      })
      setSubmitSuccess(true)
      setTimeout(() => {
        setModalOpen(false)
        loadData(true)
      }, 1500)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit withdrawal request')
    } finally {
      setSubmitting(false)
    }
  }

  /* ---- Loading state ---- */

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  /* ---- Render ---- */

  return (
    <motion.div
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Wallet size={28} /> Withdrawals
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Request and track your earnings withdrawals
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="dash-refresh-btn"
            onClick={() => loadData(true)}
            disabled={refreshing}
            title="Refresh data"
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
          <Button onClick={openModal}>
            <ArrowDownToLine size={16} className="mr-2" />
            Request Withdrawal
          </Button>
        </div>
      </motion.div>

      {/* Balance Card */}
      <motion.div variants={item}>
        <div
          className="rounded-xl p-6"
          style={{
            background: 'linear-gradient(135deg, rgba(34,197,94,0.08), var(--glass-bg))',
            border: '1px solid rgba(34,197,94,0.2)',
          }}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Total Earnings</p>
              <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {formatCurrency(balance?.totalEarnings ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Completed Withdrawals</p>
              <p className="text-lg font-bold" style={{ color: 'var(--text-secondary)' }}>
                {formatCurrency(balance?.completedWithdrawals ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Pending</p>
              <p className="text-lg font-bold" style={{ color: 'var(--warning)' }}>
                {formatCurrency(balance?.pendingWithdrawals ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Available Balance</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--success)' }}>
                {formatCurrency(balance?.availableBalance ?? 0)}
              </p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Withdrawal History Table */}
      <motion.div variants={item}>
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
        >
          <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-color)' }}>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Withdrawal History</h2>
          </div>

          {!data || data.withdrawals.length === 0 ? (
            <div className="p-12 text-center">
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
                style={{ background: 'rgba(34,197,94,0.1)' }}
              >
                <ArrowDownToLine size={24} style={{ color: 'var(--primary)' }} />
              </div>
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No withdrawals yet</p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Your withdrawal history will appear here once you make your first request.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="text-xs uppercase tracking-wider"
                      style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-card)' }}
                    >
                      <th className="text-left px-5 py-3 font-medium">Date</th>
                      <th className="text-right px-5 py-3 font-medium">Amount</th>
                      <th className="text-left px-5 py-3 font-medium">Wallet</th>
                      <th className="text-left px-5 py-3 font-medium">Status</th>
                      <th className="text-right px-5 py-3 font-medium">TX Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.withdrawals.map((w) => {
                      const sc = statusConfig[w.status] ?? statusConfig.PENDING!
                      return (
                        <tr
                          key={w.id}
                          className="transition-colors hover:opacity-90"
                          style={{ borderBottom: '1px solid var(--glass-border)' }}
                        >
                          <td className="px-5 py-3" style={{ color: 'var(--text-primary)' }}>
                            {new Date(w.createdAt).toLocaleDateString()}
                          </td>
                          <td className="px-5 py-3 text-right font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {formatCurrency(w.amount)}
                          </td>
                          <td className="px-5 py-3">
                            <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                              {w.walletAddress.slice(0, 6)}...{w.walletAddress.slice(-4)}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                              style={{ background: sc.bg, color: sc.color }}
                            >
                              {sc.icon}
                              {w.status}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right">
                            {w.txHash ? (
                              <a
                                href={`https://solscan.io/tx/${w.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-mono inline-flex items-center gap-1 hover:opacity-80"
                                style={{ color: 'var(--primary)' }}
                              >
                                {w.txHash.slice(0, 8)}...
                                <ExternalLink size={10} />
                              </a>
                            ) : (
                              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {data.pages > 1 && (
                <div
                  className="flex items-center justify-between px-5 py-3"
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Page {data.page} of {data.pages}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                      Previous
                    </Button>
                    <Button variant="ghost" size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>

      {/* Request Withdrawal Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Request Withdrawal">
        {submitSuccess ? (
          <div className="text-center py-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3"
              style={{ background: 'rgba(34,197,94,0.1)' }}
            >
              <CircleCheck size={28} style={{ color: 'var(--success)' }} />
            </div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Withdrawal Requested</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Your request is being reviewed and will be processed shortly.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div
              className="rounded-lg p-3 flex items-center justify-between"
              style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}
            >
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Available</span>
              <span className="text-sm font-bold" style={{ color: 'var(--success)' }}>
                {formatCurrency(balance?.availableBalance ?? 0)}
              </span>
            </div>

            <Input
              label="Amount (USD)"
              type="number"
              step="0.01"
              min="0"
              max={balance?.availableBalance ?? 0}
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />

            {balance && balance.availableBalance > 0 && (
              <button
                type="button"
                className="text-xs font-medium px-2 py-1 rounded"
                style={{ color: 'var(--primary)', background: 'rgba(34,197,94,0.1)' }}
                onClick={() => setAmount(String(balance.availableBalance))}
              >
                Withdraw Max
              </button>
            )}

            <Input
              label="Wallet Address (SOL)"
              type="text"
              placeholder="Enter your Solana wallet address"
              value={walletAddress}
              onChange={(e) => setWalletAddress(e.target.value)}
            />

            {submitError && (
              <p className="text-xs font-medium" style={{ color: 'var(--danger)' }}>{submitError}</p>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => setModalOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={handleSubmit}
                loading={submitting}
                disabled={submitting}
              >
                Submit Request
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </motion.div>
  )
}
