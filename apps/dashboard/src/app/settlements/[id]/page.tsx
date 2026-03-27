'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { ConfirmModal } from '@/components/ui/Modal'
import { api } from '@/lib/api'

interface Settlement {
  id: string
  nodeId: string
  walletAddress: string
  gpuTier: string
  amount: number
  currency: string
  status: string
  jobCount: number
  periodStart: string
  periodEnd: string
  txHash: string | null
  txConfirmed: boolean
  createdAt: string
  processedAt: string | null
  jobs: Array<{
    id: string
    deploymentId: string
    earnings: number
    durationSeconds: number
    completedAt: string
  }>
  payment: {
    id: string
    txHash: string
    status: string
    confirmedAt: string | null
  } | null
}

export default function SettlementDetailPage() {
  const params = useParams()
  const router = useRouter()
  const settlementId = params.id as string

  const [settlement, setSettlement] = useState<Settlement | null>(null)
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [showFailModal, setShowFailModal] = useState(false)
  const [txHashInput, setTxHashInput] = useState('')
  const [failReason, setFailReason] = useState('')

  useEffect(() => {
    loadSettlement()
  }, [settlementId])

  async function loadSettlement() {
    setLoading(true)
    try {
      const data = await api.settlements.get(settlementId)
      setSettlement(data)
    } catch (err) {
      console.error('Failed to load settlement:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleProcess() {
    if (!settlement) return
    setProcessing(true)
    try {
      await api.payments.process(settlement.id, 'USDC')
      await loadSettlement()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to process payment')
    } finally {
      setProcessing(false)
    }
  }

  async function handleComplete() {
    if (!txHashInput.trim()) {
      alert('Please enter a transaction hash')
      return
    }
    setProcessing(true)
    try {
      await api.settlements.complete(settlementId, txHashInput.trim())
      setShowCompleteModal(false)
      setTxHashInput('')
      await loadSettlement()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to complete settlement')
    } finally {
      setProcessing(false)
    }
  }

  async function handleFail() {
    if (!failReason.trim()) {
      alert('Please enter a reason')
      return
    }
    setProcessing(true)
    try {
      await api.settlements.fail(settlementId, failReason.trim())
      setShowFailModal(false)
      setFailReason('')
      await loadSettlement()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to mark settlement as failed')
    } finally {
      setProcessing(false)
    }
  }

  async function handleRetry() {
    setProcessing(true)
    try {
      await api.settlements.retry(settlementId)
      await loadSettlement()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to retry settlement')
    } finally {
      setProcessing(false)
    }
  }

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      PENDING: 'bg-yellow-500/20 text-yellow-400',
      PROCESSING: 'bg-blue-500/20 text-blue-400',
      COMPLETED: 'bg-accent/20 text-accent',
      FAILED: 'bg-error/20 text-error',
    }
    return <span className={`px-3 py-1 text-sm font-medium rounded-full ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>{status}</span>
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!settlement) {
    return (
      <div className="text-center py-12">
        <p className="text-text-muted">Settlement not found</p>
        <Link href="/financial" className="text-accent hover:underline mt-2 inline-block">
          Back to Financial
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <button onClick={() => router.back()} className="text-text-muted hover:text-text-primary">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-2xl font-bold text-text-primary">Settlement Details</h1>
            {getStatusBadge(settlement.status)}
          </div>
          <p className="text-text-muted text-sm font-mono">{settlement.id}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {settlement.status === 'PENDING' && (
            <>
              <button
                onClick={handleProcess}
                disabled={processing}
                className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50"
              >
                {processing ? 'Processing...' : 'Process Payment'}
              </button>
              <button
                onClick={() => setShowCompleteModal(true)}
                className="px-4 py-2 bg-surface-hover text-text-primary rounded-lg hover:bg-accent/10"
              >
                Mark Complete
              </button>
              <button
                onClick={() => setShowFailModal(true)}
                className="px-4 py-2 bg-error/10 text-error rounded-lg hover:bg-error/20"
              >
                Mark Failed
              </button>
            </>
          )}
          {settlement.status === 'FAILED' && (
            <button
              onClick={handleRetry}
              disabled={processing}
              className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50"
            >
              {processing ? 'Retrying...' : 'Retry Settlement'}
            </button>
          )}
        </div>
      </div>

      {/* Settlement Info */}
      <div className="grid md:grid-cols-2 gap-6">
        <Card className="p-6">
          <h3 className="font-semibold text-text-primary mb-4">Settlement Information</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-text-muted">Amount</dt>
              <dd className="font-medium text-text-primary">${settlement.amount.toFixed(2)} {settlement.currency}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Job Count</dt>
              <dd className="text-text-primary">{settlement.jobCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Period</dt>
              <dd className="text-text-primary text-sm">
                {new Date(settlement.periodStart).toLocaleDateString()} - {new Date(settlement.periodEnd).toLocaleDateString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Created</dt>
              <dd className="text-text-primary text-sm">{new Date(settlement.createdAt).toLocaleString()}</dd>
            </div>
            {settlement.processedAt && (
              <div className="flex justify-between">
                <dt className="text-text-muted">Processed</dt>
                <dd className="text-text-primary text-sm">{new Date(settlement.processedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </Card>

        <Card className="p-6">
          <h3 className="font-semibold text-text-primary mb-4">Node Information</h3>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-text-muted">Node ID</dt>
              <dd>
                <Link href={`/nodes/${settlement.nodeId}`} className="text-accent hover:underline font-mono text-sm">
                  {settlement.nodeId.substring(0, 12)}...
                </Link>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">GPU Tier</dt>
              <dd className="text-text-primary">{settlement.gpuTier}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Wallet Address</dt>
              <dd className="text-text-primary font-mono text-sm truncate max-w-[200px]" title={settlement.walletAddress}>
                {settlement.walletAddress}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* Payment Information */}
      {(settlement.txHash || settlement.payment) && (
        <Card className="p-6">
          <h3 className="font-semibold text-text-primary mb-4">Payment Information</h3>
          <dl className="space-y-3">
            {settlement.txHash && (
              <div className="flex justify-between items-center">
                <dt className="text-text-muted">Transaction Hash</dt>
                <dd>
                  <a
                    href={`https://solscan.io/tx/${settlement.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline font-mono text-sm"
                  >
                    {settlement.txHash.substring(0, 20)}...
                  </a>
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-text-muted">Confirmed</dt>
              <dd className={settlement.txConfirmed ? 'text-accent' : 'text-warning'}>
                {settlement.txConfirmed ? 'Yes' : 'Pending'}
              </dd>
            </div>
            {settlement.payment && (
              <>
                <div className="flex justify-between">
                  <dt className="text-text-muted">Payment Status</dt>
                  <dd className="text-text-primary">{settlement.payment.status}</dd>
                </div>
                {settlement.payment.confirmedAt && (
                  <div className="flex justify-between">
                    <dt className="text-text-muted">Confirmed At</dt>
                    <dd className="text-text-primary text-sm">{new Date(settlement.payment.confirmedAt).toLocaleString()}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </Card>
      )}

      {/* Jobs in Settlement */}
      <Card className="p-6">
        <h3 className="font-semibold text-text-primary mb-4">Jobs Included ({settlement.jobs.length})</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-xs font-medium text-text-muted uppercase">Job ID</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-text-muted uppercase">Deployment</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-text-muted uppercase">Duration</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-text-muted uppercase">Earnings</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-text-muted uppercase">Completed</th>
              </tr>
            </thead>
            <tbody>
              {settlement.jobs.map((job) => (
                <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover/50">
                  <td className="py-2 px-3">
                    <Link href={`/jobs/${job.id}`} className="text-accent hover:underline font-mono text-sm">
                      {job.id.substring(0, 12)}...
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-text-primary">{job.deploymentId}</td>
                  <td className="py-2 px-3 text-text-muted">
                    {(job.durationSeconds / 3600).toFixed(2)}h
                  </td>
                  <td className="py-2 px-3 font-medium text-accent">${job.earnings.toFixed(2)}</td>
                  <td className="py-2 px-3 text-text-muted text-sm">
                    {new Date(job.completedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Complete Modal */}
      <ConfirmModal
        isOpen={showCompleteModal}
        onClose={() => setShowCompleteModal(false)}
        onConfirm={handleComplete}
        title="Mark Settlement Complete"
        message="Enter the transaction hash to mark this settlement as complete."
        confirmText="Complete"
        loading={processing}
      >
        <input
          type="text"
          value={txHashInput}
          onChange={(e) => setTxHashInput(e.target.value)}
          placeholder="Enter transaction hash..."
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary mb-4 focus:outline-none focus:border-accent"
        />
      </ConfirmModal>

      {/* Fail Modal */}
      <ConfirmModal
        isOpen={showFailModal}
        onClose={() => setShowFailModal(false)}
        onConfirm={handleFail}
        title="Mark Settlement Failed"
        message="Enter the reason for marking this settlement as failed."
        confirmText="Mark Failed"
        variant="danger"
        loading={processing}
      >
        <input
          type="text"
          value={failReason}
          onChange={(e) => setFailReason(e.target.value)}
          placeholder="Enter reason..."
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary mb-4 focus:outline-none focus:border-accent"
        />
      </ConfirmModal>
    </div>
  )
}
