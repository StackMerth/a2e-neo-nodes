'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, CreditCard, Server, FileText, Briefcase, Receipt, DollarSign, Clock } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  MetricTriad,
} from '@/components/dashboard/FuturisticShell'

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
  const { addToast } = useToast()
  const settlementId = params.id as string

  const [settlement, setSettlement] = useState<Settlement | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [showFailModal, setShowFailModal] = useState(false)
  const [txHashInput, setTxHashInput] = useState('')
  const [failReason, setFailReason] = useState('')

  useEffect(() => {
    loadSettlement()
  }, [settlementId])

  async function loadSettlement(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await api.settlements.get(settlementId)
      setSettlement(data)
    } catch (err) {
      console.error('Failed to load settlement:', err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  async function handleProcess() {
    if (!settlement) return
    setProcessing(true)
    try {
      await api.payments.process(settlement.id, 'USDC')
      addToast({ type: 'success', title: 'Payment Processed', message: 'Settlement payment processed successfully' })
      await loadSettlement()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to process payment' })
    } finally {
      setProcessing(false)
    }
  }

  async function handleComplete() {
    if (!txHashInput.trim()) {
      addToast({ type: 'warning', title: 'Validation Error', message: 'Please enter a transaction hash' })
      return
    }
    setProcessing(true)
    try {
      await api.settlements.complete(settlementId, txHashInput.trim())
      setShowCompleteModal(false)
      setTxHashInput('')
      addToast({ type: 'success', title: 'Settlement Completed', message: 'Settlement marked as completed' })
      await loadSettlement()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to complete settlement' })
    } finally {
      setProcessing(false)
    }
  }

  async function handleFail() {
    if (!failReason.trim()) {
      addToast({ type: 'warning', title: 'Validation Error', message: 'Please enter a reason' })
      return
    }
    setProcessing(true)
    try {
      await api.settlements.fail(settlementId, failReason.trim())
      setShowFailModal(false)
      setFailReason('')
      addToast({ type: 'success', title: 'Settlement Failed', message: 'Settlement marked as failed' })
      await loadSettlement()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to mark settlement as failed' })
    } finally {
      setProcessing(false)
    }
  }

  async function handleRetry() {
    setProcessing(true)
    try {
      await api.settlements.retry(settlementId)
      addToast({ type: 'success', title: 'Retry Queued', message: 'Settlement queued for retry' })
      await loadSettlement()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Failed to retry settlement' })
    } finally {
      setProcessing(false)
    }
  }

  if (loading || !settlement) {
    return (
      <DashboardShell title="Settlement" subtitle="Loading...">
        <div className="lg:col-span-3">
          <SectionCard>
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
              {loading ? 'Loading settlement...' : 'Settlement not found'}
            </p>
            {!loading && (
              <div className="text-center">
                <Link href="/financial" className="text-accent hover:underline mt-2 inline-block">
                  Back to Financial
                </Link>
              </div>
            )}
          </SectionCard>
        </div>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell
      title={`Settlement: ${settlement.id.slice(0, 8)}`}
      subtitle={settlement.status}
      onRefresh={() => loadSettlement(true)}
      refreshing={refreshing}
    >
      <DashboardMainColumn>
        <Link href="/financial" className="inline-flex items-center gap-1.5 text-sm hover:text-accent transition-colors -mt-2" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={16} />
          Back to Settlements
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg text-sm font-medium ${
            settlement.status === 'COMPLETED' ? 'bg-accent/10 text-accent border border-accent/20' :
            settlement.status === 'FAILED' ? 'bg-error/10 text-error border border-error/20' :
            settlement.status === 'PROCESSING' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
            'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
          }`}>
            {settlement.status}
          </span>
          <div className="flex-1" />
          {settlement.status === 'PENDING' && (
            <>
              <button
                onClick={handleProcess}
                disabled={processing}
                className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
              >
                {processing ? 'Processing...' : 'Process Payment'}
              </button>
              <button
                onClick={() => setShowCompleteModal(true)}
                className="px-4 py-2 bg-surface-hover rounded-lg hover:bg-accent/10 text-sm font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                Mark Complete
              </button>
              <button
                onClick={() => setShowFailModal(true)}
                className="px-4 py-2 bg-error/10 text-error rounded-lg hover:bg-error/20 text-sm font-medium"
              >
                Mark Failed
              </button>
            </>
          )}
          {settlement.status === 'FAILED' && (
            <button
              onClick={handleRetry}
              disabled={processing}
              className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50 text-sm font-medium"
            >
              {processing ? 'Retrying...' : 'Retry Settlement'}
            </button>
          )}
        </div>

        <MetricTriad
          metrics={[
            {
              label: 'Amount',
              value: `$${settlement.amount.toFixed(2)}`,
              detail: settlement.currency,
              icon: DollarSign,
              tone: 'green',
            },
            {
              label: 'Job Count',
              value: String(settlement.jobCount),
              icon: Briefcase,
              tone: 'purple',
            },
            {
              label: 'Period',
              value: new Date(settlement.periodStart).toLocaleDateString(),
              detail: `to ${new Date(settlement.periodEnd).toLocaleDateString()}`,
              icon: Clock,
              tone: 'orange',
            },
          ]}
        />

        <SectionCard title={`Jobs Included (${settlement.jobs?.length ?? 0})`} icon={Briefcase}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Job ID</th>
                  <th className="text-left py-2 px-3 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Deployment</th>
                  <th className="text-left py-2 px-3 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Duration</th>
                  <th className="text-left py-2 px-3 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Earnings</th>
                  <th className="text-left py-2 px-3 text-xs font-medium uppercase" style={{ color: 'var(--text-muted)' }}>Completed</th>
                </tr>
              </thead>
              <tbody>
                {(settlement.jobs ?? []).map((job) => (
                  <tr key={job.id} className="border-b border-border/50 hover:bg-surface-hover/50">
                    <td className="py-2 px-3">
                      <Link href={`/jobs/${job.id}`} className="text-accent hover:underline font-mono text-sm">
                        {job.id.substring(0, 12)}...
                      </Link>
                    </td>
                    <td className="py-2 px-3" style={{ color: 'var(--text-primary)' }}>{job.deploymentId}</td>
                    <td className="py-2 px-3" style={{ color: 'var(--text-muted)' }}>
                      {(job.durationSeconds / 3600).toFixed(2)}h
                    </td>
                    <td className="py-2 px-3 font-medium text-accent">${job.earnings.toFixed(2)}</td>
                    <td className="py-2 px-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                      {new Date(job.completedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Settlement Info" icon={FileText}>
          <dl className="space-y-3">
            <Row label="Amount" value={`$${settlement.amount.toFixed(2)} ${settlement.currency}`} />
            <Row label="Job Count" value={String(settlement.jobCount)} />
            <Row label="Created" value={new Date(settlement.createdAt).toLocaleString()} small />
            {settlement.processedAt && (
              <Row label="Processed" value={new Date(settlement.processedAt).toLocaleString()} small />
            )}
          </dl>
        </SectionCard>

        <SectionCard title="Node" icon={Server}>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-sm" style={{ color: 'var(--text-muted)' }}>Node ID</dt>
              <dd>
                <Link href={`/nodes/${settlement.nodeId}`} className="text-accent hover:underline font-mono text-sm">
                  {settlement.nodeId.substring(0, 8)}...
                </Link>
              </dd>
            </div>
            <Row label="GPU Tier" value={settlement.gpuTier} />
            <div className="flex flex-col">
              <dt className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>Wallet</dt>
              <dd className="font-mono text-xs break-all" style={{ color: 'var(--text-primary)' }}>
                {settlement.walletAddress}
              </dd>
            </div>
          </dl>
        </SectionCard>

        {(settlement.txHash || settlement.payment) && (
          <SectionCard title="Transaction" icon={CreditCard}>
            <dl className="space-y-3">
              {settlement.txHash && (
                <div className="flex flex-col">
                  <dt className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>Tx Hash</dt>
                  <dd>
                    <a
                      href={`https://solscan.io/tx/${settlement.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline font-mono text-xs inline-flex items-center gap-1 break-all"
                    >
                      {settlement.txHash.substring(0, 24)}...
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-sm" style={{ color: 'var(--text-muted)' }}>Confirmed</dt>
                <dd className={settlement.txConfirmed ? 'text-accent' : 'text-warning'}>
                  {settlement.txConfirmed ? 'Yes' : 'Pending'}
                </dd>
              </div>
              {settlement.payment && (
                <>
                  <Row label="Payment" value={settlement.payment.status} />
                  {settlement.payment.confirmedAt && (
                    <Row label="Confirmed at" value={new Date(settlement.payment.confirmedAt).toLocaleString()} small />
                  )}
                </>
              )}
            </dl>
          </SectionCard>
        )}
      </DashboardRightRail>

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
          className="w-full px-3 py-2 bg-background border border-border rounded-lg mb-4 focus:outline-none focus:border-accent"
          style={{ color: 'var(--text-primary)' }}
        />
      </ConfirmModal>

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
          className="w-full px-3 py-2 bg-background border border-border rounded-lg mb-4 focus:outline-none focus:border-accent"
          style={{ color: 'var(--text-primary)' }}
        />
      </ConfirmModal>
    </DashboardShell>
  )
}

function Row({ label, value, small = false }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-sm" style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className={small ? 'text-sm' : ''} style={{ color: 'var(--text-primary)' }}>{value}</dd>
    </div>
  )
}
