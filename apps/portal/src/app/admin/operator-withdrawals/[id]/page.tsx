'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ArrowUpToLine,
  Check,
  X,
  Loader2,
  ExternalLink,
  CircleDot,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

type Status = 'PENDING' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED'

interface WithdrawalDetail {
  id: string
  nodeRunnerId: string
  amount: number
  currency: string
  status: Status
  payoutMethod: 'SOLANA' | 'STRIPE_CONNECT'
  walletAddress: string | null
  txHash: string | null
  adminNote: string | null
  rejectionReason: string | null
  requestedAt: string
  approvedAt: string | null
  processedAt: string | null
  nodeRunner: {
    id: string
    name: string
    email: string | null
    walletAddress: string | null
  } | null
}

const STATUS_COLORS: Record<Status, { bg: string; text: string }> = {
  PENDING: { bg: 'rgba(245, 158, 11, 0.12)', text: 'var(--warn)' },
  APPROVED: { bg: 'rgba(139, 92, 246, 0.12)', text: '#8b5cf6' },
  PROCESSING: { bg: 'rgba(6, 182, 212, 0.12)', text: '#06b6d4' },
  COMPLETED: { bg: 'rgba(34, 197, 94, 0.12)', text: 'var(--primary)' },
  REJECTED: { bg: 'rgba(113, 113, 122, 0.12)', text: 'var(--text-secondary)' },
}

const TIMELINE_STEPS: { label: string; matches: Status[] }[] = [
  { label: 'Requested', matches: ['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED'] },
  { label: 'Approved', matches: ['APPROVED', 'PROCESSING', 'COMPLETED'] },
  { label: 'Processing', matches: ['PROCESSING', 'COMPLETED'] },
  { label: 'Completed', matches: ['COMPLETED'] },
]

export default function OperatorWithdrawalDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { toast } = useToast()
  const [row, setRow] = useState<WithdrawalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [completeModal, setCompleteModal] = useState<{ txHash: string } | null>(null)
  const [rejectModal, setRejectModal] = useState<{ reason: string } | null>(null)

  useEffect(() => {
    if (params?.id) void load(params.id)
  }, [params?.id])

  async function load(id: string) {
    setLoading(true)
    try {
      const data = await apiFetch<WithdrawalDetail>(`/v1/admin/withdrawals/${id}`)
      setRow(data)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function patch(
    action: 'approve' | 'process' | 'process-stripe' | 'complete' | 'reject',
    body?: Record<string, unknown>,
  ) {
    if (!row) return
    setBusy(action)
    try {
      await apiFetch(`/v1/admin/withdrawals/${row.id}/${action}`, {
        method: 'PATCH',
        body,
      })
      toast('success', `${action} OK`)
      setCompleteModal(null)
      setRejectModal(null)
      await load(row.id)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : `${action} failed`)
    } finally {
      setBusy(null)
    }
  }

  if (loading || !row) {
    return (
      <div className="min-h-[400px] flex items-center justify-center">
        <Loader2 size={28} className="animate-spin opacity-60" />
      </div>
    )
  }

  const statusColor = STATUS_COLORS[row.status]
  const canApprove = row.status === 'PENDING'
  const canReject = row.status === 'PENDING' || row.status === 'APPROVED'
  const canProcess = row.status === 'APPROVED' && row.payoutMethod === 'SOLANA'
  const canProcessStripe =
    row.status === 'APPROVED' && row.payoutMethod === 'STRIPE_CONNECT'
  const canComplete =
    (row.status === 'APPROVED' || row.status === 'PROCESSING') &&
    row.payoutMethod === 'SOLANA'

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <button
        onClick={() => router.push('/admin/operator-withdrawals')}
        className="inline-flex items-center gap-2 text-sm opacity-70 hover:opacity-100"
        style={{ color: 'var(--text-secondary)' }}
      >
        <ArrowLeft size={14} /> Back to queue
      </button>

      <div
        className="rounded-2xl p-6"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
      >
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{ background: statusColor.bg }}
              >
                <ArrowUpToLine size={20} style={{ color: statusColor.text }} />
              </div>
              <div>
                <h1 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                  ${row.amount.toFixed(2)}
                </h1>
                <p className="text-sm opacity-70" style={{ color: 'var(--text-secondary)' }}>
                  {row.nodeRunner?.name ?? '(unnamed)'}
                  {row.nodeRunner?.email ? ` · ${row.nodeRunner.email}` : ''}
                </p>
              </div>
            </div>
          </div>
          <span
            className="text-xs px-2 py-1 rounded uppercase font-mono"
            style={{ background: statusColor.bg, color: statusColor.text }}
          >
            {row.status}
          </span>
        </div>

        {/* Timeline */}
        <div className="mt-8 flex items-center justify-between">
          {TIMELINE_STEPS.map((step, i) => {
            const done = step.matches.includes(row.status)
            const skipped = row.status === 'REJECTED' && i > 0
            return (
              <div key={step.label} className="flex items-center" style={{ flex: i === TIMELINE_STEPS.length - 1 ? 0 : 1 }}>
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: done
                      ? 'rgba(34, 197, 94, 0.18)'
                      : skipped
                        ? 'rgba(239, 68, 68, 0.14)'
                        : 'var(--bg-secondary)',
                    color: done
                      ? 'var(--primary)'
                      : skipped
                        ? 'var(--danger)'
                        : 'var(--text-secondary)',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  {done ? <Check size={14} /> : skipped ? <X size={14} /> : <CircleDot size={14} />}
                </div>
                <div className="ml-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {step.label}
                </div>
                {i < TIMELINE_STEPS.length - 1 && (
                  <div className="flex-1 mx-3 h-px" style={{ background: 'var(--border-color)' }} />
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-6 grid sm:grid-cols-2 gap-4 text-sm">
          <Field label="Payout method" value={row.payoutMethod === 'STRIPE_CONNECT' ? 'Stripe Connect' : 'Solana USDC'} />
          <Field
            label="Destination"
            value={row.walletAddress ? `${row.walletAddress.slice(0, 10)}…${row.walletAddress.slice(-6)}` : '—'}
            mono
          />
          <Field label="Requested" value={new Date(row.requestedAt).toLocaleString()} />
          <Field
            label="Processed"
            value={row.processedAt ? new Date(row.processedAt).toLocaleString() : '—'}
          />
          {row.txHash && (
            <div className="sm:col-span-2">
              <div className="text-xs opacity-60 mb-1">Transaction</div>
              <a
                href={`https://solscan.io/tx/${row.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-mono break-all"
                style={{ color: 'var(--primary)' }}
              >
                {row.txHash} <ExternalLink size={12} />
              </a>
            </div>
          )}
          {row.adminNote && <Field label="Admin note" value={row.adminNote} />}
          {row.rejectionReason && <Field label="Rejection reason" value={row.rejectionReason} />}
        </div>
      </div>

      {/* Action panel */}
      <div
        className="rounded-2xl p-6"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
      >
        <div className="text-sm font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
          Actions
        </div>
        <div className="flex flex-wrap gap-2">
          {canApprove && (
            <Button onClick={() => patch('approve')} disabled={!!busy}>
              {busy === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              <span className="ml-1.5">Approve</span>
            </Button>
          )}
          {canProcess && (
            <Button onClick={() => patch('process')} disabled={!!busy} variant="ghost">
              Mark Processing
            </Button>
          )}
          {canProcessStripe && (
            <Button onClick={() => patch('process-stripe')} disabled={!!busy}>
              Process via Stripe (auto)
            </Button>
          )}
          {canComplete && (
            <Button onClick={() => setCompleteModal({ txHash: '' })} disabled={!!busy} variant="ghost">
              Mark Completed (with TX)
            </Button>
          )}
          {canReject && (
            <Button onClick={() => setRejectModal({ reason: '' })} disabled={!!busy} variant="danger">
              <X size={14} /> <span className="ml-1.5">Reject</span>
            </Button>
          )}
          {!canApprove && !canReject && !canProcess && !canProcessStripe && !canComplete && (
            <div className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
              No actions available for status {row.status}.
            </div>
          )}
        </div>
      </div>

      {/* Complete modal (txHash) */}
      <Modal
        open={!!completeModal}
        onClose={() => setCompleteModal(null)}
        title="Mark withdrawal completed"
      >
        {completeModal && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Paste the Solana transaction hash you just sent. The operator gets
              a notification with a Solscan link.
            </p>
            <input
              type="text"
              value={completeModal.txHash}
              onChange={(e) => setCompleteModal({ txHash: e.target.value })}
              placeholder="Solana tx signature"
              className="w-full rounded-lg p-2.5 text-sm font-mono"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCompleteModal(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => patch('complete', { txHash: completeModal.txHash.trim() })}
                disabled={!!busy || completeModal.txHash.trim().length === 0}
              >
                Mark Completed
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reject modal (reason) */}
      <Modal open={!!rejectModal} onClose={() => setRejectModal(null)} title="Reject withdrawal">
        {rejectModal && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Rejecting marks the request REJECTED. The operator&apos;s balance
              ledger is unaffected (no funds moved). They see your reason in
              their notification.
            </p>
            <textarea
              value={rejectModal.reason}
              onChange={(e) => setRejectModal({ reason: e.target.value })}
              placeholder="Reason for rejection (visible to operator)"
              rows={3}
              maxLength={500}
              className="w-full rounded-lg p-2.5 text-sm"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRejectModal(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => patch('reject', { reason: rejectModal.reason.trim() })}
                disabled={!!busy || rejectModal.reason.trim().length === 0}
                variant="danger"
              >
                Reject
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs opacity-60 mb-1">{label}</div>
      <div
        className={`text-sm ${mono ? 'font-mono' : ''}`}
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  )
}
