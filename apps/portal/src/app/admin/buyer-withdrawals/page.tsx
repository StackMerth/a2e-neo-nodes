'use client'

import { useEffect, useState } from 'react'
import { ArrowDownToLine, Check, X, Loader2, AlertTriangle } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface BuyerWithdrawalRow {
  id: string
  userId: string
  amountUsd: number
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REJECTED'
  walletAddress: string
  txHash: string | null
  error: string | null
  requestedAt: string
  processedAt: string | null
  user: { id: string; email: string | null; walletAddress: string | null } | null
}

type WithdrawalRow = BuyerWithdrawalRow & Record<string, unknown>

const STATUS_COLORS: Record<BuyerWithdrawalRow['status'], { bg: string; text: string }> = {
  PENDING: { bg: 'rgba(245, 158, 11, 0.12)', text: 'var(--warn)' },
  PROCESSING: { bg: 'rgba(6, 182, 212, 0.12)', text: '#06b6d4' },
  COMPLETED: { bg: 'rgba(34, 197, 94, 0.12)', text: 'var(--primary)' },
  FAILED: { bg: 'rgba(239, 68, 68, 0.12)', text: 'var(--danger)' },
  REJECTED: { bg: 'rgba(113, 113, 122, 0.12)', text: 'var(--text-secondary)' },
}

function timeAgo(d: string | null): string {
  if (!d) return '—'
  const seconds = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function shortWallet(addr: string | null): string {
  if (!addr) return '—'
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export default function AdminBuyerWithdrawalsPage() {
  const { toast } = useToast()
  const [rows, setRows] = useState<BuyerWithdrawalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | BuyerWithdrawalRow['status']>('PENDING')
  const [busy, setBusy] = useState<string | null>(null)
  const [rejectModal, setRejectModal] = useState<{
    row: BuyerWithdrawalRow
    reason: string
  } | null>(null)

  useEffect(() => {
    void load()
  }, [filter])

  async function load() {
    setLoading(true)
    try {
      const q = filter === 'ALL' ? '' : `?status=${filter}`
      const data = await apiFetch<{ withdrawals: BuyerWithdrawalRow[] }>(
        `/v1/admin/buyer-withdrawals${q}&limit=50`.replace('?&', '?'),
      )
      setRows(data.withdrawals)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function approve(row: BuyerWithdrawalRow) {
    if (
      !confirm(
        `Approve withdrawal of $${row.amountUsd.toFixed(2)} to ${shortWallet(row.walletAddress)}?` +
          `\n\nThis broadcasts USDC on-chain immediately. Action is irreversible.`,
      )
    ) {
      return
    }
    setBusy(row.id)
    try {
      const resp = await apiFetch<{ status: string; txHash?: string }>(
        `/v1/admin/buyer-withdrawals/${row.id}/approve`,
        { method: 'POST' },
      )
      if (resp.status === 'COMPLETED') {
        toast('success', `Sent. Tx: ${(resp.txHash ?? '').slice(0, 12)}…`)
      } else {
        toast('info', `Status: ${resp.status}`)
      }
      void load()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setBusy(null)
    }
  }

  async function submitReject() {
    if (!rejectModal) return
    if (rejectModal.reason.trim().length === 0) {
      toast('error', 'Reason required')
      return
    }
    setBusy(rejectModal.row.id)
    try {
      await apiFetch(
        `/v1/admin/buyer-withdrawals/${rejectModal.row.id}/reject`,
        {
          method: 'POST',
          body: { reason: rejectModal.reason.trim() },
        },
      )
      toast('success', 'Rejected; balance refunded')
      setRejectModal(null)
      void load()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Reject failed')
    } finally {
      setBusy(null)
    }
  }

  const columns: DataTableColumn<WithdrawalRow>[] = [
    {
      key: 'requestedAt',
      header: 'Requested',
      mono: true,
      render: (r) => timeAgo(r.requestedAt),
    },
    {
      key: 'user',
      header: 'Buyer',
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {r.user?.email ?? '(no email)'}
          </span>
          <span className="text-2xs font-mono opacity-60" style={{ color: 'var(--text-secondary)' }}>
            {r.userId}
          </span>
        </div>
      ),
    },
    {
      key: 'amountUsd',
      header: 'Amount',
      mono: true,
      align: 'right',
      render: (r) => (
        <span style={{ color: 'var(--primary)' }}>${r.amountUsd.toFixed(2)}</span>
      ),
    },
    {
      key: 'walletAddress',
      header: 'Destination',
      mono: true,
      render: (r) => shortWallet(r.walletAddress),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const c = STATUS_COLORS[r.status]
        return (
          <span
            className="text-2xs px-1.5 py-0.5 rounded uppercase font-mono"
            style={{ background: c.bg, color: c.text }}
          >
            {r.status}
          </span>
        )
      },
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (r) => {
        if (r.status !== 'PENDING') {
          return (
            <span className="text-2xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
              —
            </span>
          )
        }
        return (
          <div className="flex justify-end gap-2">
            <button
              onClick={() => approve(r)}
              disabled={busy === r.id}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded transition-colors disabled:opacity-50"
              style={{ background: 'rgba(34, 197, 94, 0.12)', color: 'var(--primary)' }}
            >
              {busy === r.id ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Check size={12} />
              )}{' '}
              Approve
            </button>
            <button
              onClick={() => setRejectModal({ row: r, reason: '' })}
              disabled={busy === r.id}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded transition-colors disabled:opacity-50"
              style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger)' }}
            >
              <X size={12} /> Reject
            </button>
          </div>
        )
      },
    },
  ]

  return (
    <DashboardShell
      title="Buyer Withdrawals"
      subtitle="Custodial payout approvals — review wallet + amount before approving"
    >
      <div className="lg:col-span-3 space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(['PENDING', 'COMPLETED', 'REJECTED', 'FAILED', 'ALL'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="text-xs px-2.5 py-1 rounded transition-colors"
              style={
                filter === f
                  ? { background: 'var(--primary)', color: 'var(--bg-primary)' }
                  : {
                      background: 'var(--bg-card)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border-color)',
                    }
              }
            >
              {f}
            </button>
          ))}
        </div>

        <DataTableCard<WithdrawalRow>
          title="Withdrawal Queue"
          icon={ArrowDownToLine}
          columns={columns}
          rows={(rows ?? []) as WithdrawalRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={ArrowDownToLine}
              title="No withdrawals to review"
              description="When buyers request withdrawals, their pending requests appear here."
            />
          }
        />
      </div>

      <Modal
        open={!!rejectModal}
        onClose={() => setRejectModal(null)}
        title="Reject withdrawal"
      >
        {rejectModal && (
          <div className="space-y-4">
            <div
              className="rounded-lg p-3 text-sm flex items-start gap-2"
              style={{ background: 'rgba(239, 68, 68, 0.08)', color: 'var(--danger)' }}
            >
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                Rejecting refunds ${rejectModal.row.amountUsd.toFixed(2)} back to the buyer&apos;s
                balance via REFUND_FAILED. The buyer sees your reason in their notification.
              </span>
            </div>
            <label className="block">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Reason (required)
              </span>
              <textarea
                value={rejectModal.reason}
                onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
                placeholder="e.g. Wallet mismatch with verified address; please contact support."
                rows={3}
                maxLength={500}
                className="mt-1 w-full rounded-lg p-2.5 text-sm"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRejectModal(null)}>
                Cancel
              </Button>
              <Button
                onClick={submitReject}
                disabled={!!busy || rejectModal.reason.trim().length === 0}
              >
                {busy ? 'Rejecting…' : 'Reject + Refund'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </DashboardShell>
  )
}
