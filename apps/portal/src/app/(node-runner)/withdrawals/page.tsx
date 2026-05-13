'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Wallet,
  ExternalLink,
  CircleCheck,
  Clock,
  Loader2,
  CircleX,
  ArrowDownToLine,
  ShieldCheck,
  TrendingUp,
  CheckCircle2,
  CircleDollarSign,
} from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  MetricTriad,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

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

type WithdrawalRow = Withdrawal & Record<string, unknown>

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

  const metrics: MetricCardData[] = [
    {
      label: 'Available',
      value: formatCurrency(balance?.availableBalance ?? 0),
      detail: 'Ready to withdraw',
      icon: CircleDollarSign,
      tone: 'green',
    },
    {
      label: 'Pending',
      value: formatCurrency(balance?.pendingWithdrawals ?? 0),
      detail: 'Awaiting processing',
      icon: Clock,
      tone: 'orange',
    },
    {
      label: 'Completed',
      value: formatCurrency(balance?.completedWithdrawals ?? 0),
      detail: `Total earnings ${formatCurrency(balance?.totalEarnings ?? 0)}`,
      icon: CheckCircle2,
      tone: 'blue',
    },
  ]

  const columns: Array<DataTableColumn<WithdrawalRow>> = [
    {
      key: 'createdAt',
      header: 'Date',
      render: (w) => new Date(w.createdAt).toLocaleDateString(),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (w) => formatCurrency(w.amount),
    },
    {
      key: 'walletAddress',
      header: 'Wallet',
      mono: true,
      render: (w) => `${w.walletAddress.slice(0, 6)}...${w.walletAddress.slice(-4)}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (w) => {
        const sc = statusConfig[w.status] ?? statusConfig.PENDING!
        return (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            style={{ background: sc.bg, color: sc.color }}
          >
            {sc.icon}
            {w.status}
          </span>
        )
      },
    },
    {
      key: 'txHash',
      header: 'TX Hash',
      align: 'right',
      render: (w) => w.txHash ? (
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
      ),
    },
  ]

  return (
    <>
      <DashboardShell
        title="Withdrawals"
        subtitle="Request and track your earnings withdrawals"
        onRefresh={() => loadData(true)}
        refreshing={refreshing}
      >
        <div className="lg:col-span-3 flex flex-col gap-6">
          <MetricTriad metrics={metrics} />

          <DataTableCard<WithdrawalRow>
            title="Withdrawal History"
            icon={Wallet}
            actions={
              <Button onClick={openModal} size="sm">
                <ArrowDownToLine size={14} className="mr-1" />
                Request Withdrawal
              </Button>
            }
            columns={columns}
            rows={(data?.withdrawals ?? []) as WithdrawalRow[]}
            loading={loading}
            empty={
              <EmptyState
                icon={TrendingUp}
                title="No withdrawals yet"
                description="Your withdrawal history will appear here once you make your first request."
              />
            }
            pagination={data ? {
              page: data.page,
              pageSize: data.limit,
              total: data.total,
              onPageChange: setPage,
            } : undefined}
          />
        </div>
      </DashboardShell>

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
    </>
  )
}
