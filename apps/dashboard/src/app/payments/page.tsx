'use client'

import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/Card'
import { api } from '@/lib/api'

interface Payment {
  id: string
  settlementId: string
  amount: number
  currency: string
  recipientAddress: string
  txHash: string | null
  status: string
  isDevMode: boolean
  createdAt: string
  confirmedAt: string | null
}

interface PaymentStats {
  currentMode: string
  modeDescription: string
  stats: {
    total: number
    confirmed: number
    failed: number
    devModePayments: number
    totalAmountPaid: number
  }
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([])
  const [stats, setStats] = useState<PaymentStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [verifying, setVerifying] = useState<string | null>(null)

  useEffect(() => {
    loadData()
  }, [filter])

  async function loadData() {
    setLoading(true)
    try {
      const [paymentsRes, statsRes] = await Promise.all([
        api.payments.list({ status: filter !== 'all' ? filter : undefined, limit: 50 }),
        api.payments.stats(),
      ])
      setPayments(paymentsRes.payments)
      setStats(statsRes)
    } catch (err) {
      console.error('Failed to load payments:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(txHash: string) {
    setVerifying(txHash)
    try {
      const result = await api.payments.verify(txHash)
      alert(`Verification: ${result.status}\nConfirmations: ${result.confirmations}`)
      loadData()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setVerifying(null)
    }
  }

  const getStatusBadge = (status: string, isDevMode: boolean) => {
    if (isDevMode) {
      return <span className="px-2 py-0.5 text-xs font-medium bg-warning/20 text-warning rounded">DEV</span>
    }
    const colors: Record<string, string> = {
      PENDING: 'bg-yellow-500/20 text-yellow-400',
      CONFIRMED: 'bg-accent/20 text-accent',
      FAILED: 'bg-error/20 text-error',
    }
    return <span className={`px-2 py-0.5 text-xs font-medium rounded ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>{status}</span>
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Payments</h1>
          <p className="text-text-muted mt-1">Track and verify payment transactions</p>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Total Payments</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{stats.stats.total}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Confirmed</p>
            <p className="text-2xl font-bold text-accent mt-1">{stats.stats.confirmed}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Failed</p>
            <p className="text-2xl font-bold text-error mt-1">{stats.stats.failed}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Dev Mode</p>
            <p className="text-2xl font-bold text-warning mt-1">{stats.stats.devModePayments}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-text-muted uppercase">Total Paid</p>
            <p className="text-2xl font-bold text-text-primary mt-1">${stats.stats.totalAmountPaid.toFixed(2)}</p>
          </Card>
        </div>
      )}

      {/* Mode Banner */}
      {stats && (
        <div className={`p-4 rounded-lg border ${stats.currentMode === 'dev' ? 'bg-warning/10 border-warning/30' : 'bg-accent/10 border-accent/30'}`}>
          <div className="flex items-center gap-3">
            <span className={`px-3 py-1 rounded-full text-sm font-bold ${stats.currentMode === 'dev' ? 'bg-warning/20 text-warning' : 'bg-accent/20 text-accent'}`}>
              {stats.currentMode.toUpperCase()} MODE
            </span>
            <span className="text-sm text-text-secondary">{stats.modeDescription}</span>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-2">
        {['all', 'PENDING', 'CONFIRMED', 'FAILED'].map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              filter === status
                ? 'bg-accent text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            {status === 'all' ? 'All' : status}
          </button>
        ))}
      </div>

      {/* Payments Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">ID</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Amount</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Recipient</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Tx Hash</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Status</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Created</th>
                <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-text-muted">Loading...</td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-text-muted">No payments found</td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.id} className="border-b border-border/50 hover:bg-surface-hover/50">
                    <td className="py-3 px-4">
                      <span className="text-xs font-mono text-text-secondary">{payment.id.substring(0, 12)}...</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-medium text-text-primary">${payment.amount.toFixed(2)}</span>
                      <span className="text-xs text-text-muted ml-1">{payment.currency}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs font-mono text-text-secondary">
                        {payment.recipientAddress.substring(0, 8)}...{payment.recipientAddress.substring(-4)}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {payment.txHash ? (
                        <a
                          href={`https://solscan.io/tx/${payment.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-accent hover:underline"
                        >
                          {payment.txHash.substring(0, 12)}...
                        </a>
                      ) : (
                        <span className="text-xs text-text-muted">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(payment.status, payment.isDevMode)}</td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-text-muted">
                        {new Date(payment.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {payment.txHash && !payment.isDevMode && (
                        <button
                          onClick={() => handleVerify(payment.txHash!)}
                          disabled={verifying === payment.txHash}
                          className="px-2 py-1 text-xs bg-accent/10 text-accent rounded hover:bg-accent/20 disabled:opacity-50"
                        >
                          {verifying === payment.txHash ? 'Verifying...' : 'Verify'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
