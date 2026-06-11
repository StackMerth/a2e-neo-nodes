'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Cpu, Check, X, Loader2, Zap, Unlock } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

interface ComputeDetail {
  id: string
  userId: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  purpose: string | null
  ratePerDay: number
  totalCost: number
  paymentSource: string
  status: string
  txHash: string | null
  txConfirmed: boolean
  eligibilityFlags: string[]
  adminNote: string | null
  allocatedNodeIds: string[]
  allocationMethod: string | null
  sshHost: string | null
  sshPort: number | null
  sshUsername: string | null
  requestedAt: string
  approvedAt: string | null
  allocatedAt: string | null
  activatedAt: string | null
  expiresAt: string | null
  completedAt: string | null
  workloadType: string | null
  tier: string | null
}

export default function AdminComputeDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { toast } = useToast()
  const [row, setRow] = useState<ComputeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [rejectModal, setRejectModal] = useState<{ reason: string } | null>(null)

  useEffect(() => {
    if (params?.id) void load(params.id)
  }, [params?.id])

  async function load(id: string) {
    setLoading(true)
    try {
      const data = await apiFetch<ComputeDetail>(`/v1/admin/compute/requests/${id}`)
      setRow(data)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function call(
    action: 'approve' | 'reject' | 'auto-allocate' | 'release-hold',
    method: 'PATCH' | 'POST',
    body?: Record<string, unknown>,
  ) {
    if (!row) return
    setBusy(action)
    try {
      await apiFetch(`/v1/admin/compute/requests/${row.id}/${action}`, {
        method,
        body,
      })
      toast('success', `${action} OK`)
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

  const isHeld = row.eligibilityFlags?.some((f) =>
    ['SEARCHING_CAPACITY', 'WAITING_ON_CAPACITY', 'HELD'].includes(f),
  )

  const canApprove = row.status === 'PENDING' || row.status === 'WAITLISTED'
  const canReject = ['PENDING', 'WAITLISTED', 'APPROVED'].includes(row.status)
  const canAutoAllocate = ['PENDING', 'APPROVED', 'WAITLISTED'].includes(row.status)
  const canReleaseHold = isHeld

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <button
        onClick={() => router.push('/admin/compute')}
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
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(6, 182, 212, 0.12)' }}
            >
              <Cpu size={20} style={{ color: '#06b6d4' }} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {row.gpuCount}× {row.gpuTier}
              </h1>
              <p className="text-sm opacity-70" style={{ color: 'var(--text-secondary)' }}>
                {row.durationDays} day{row.durationDays === 1 ? '' : 's'} · $
                {row.totalCost.toFixed(2)} · {row.paymentSource}
              </p>
            </div>
          </div>
          <span
            className="text-xs px-2 py-1 rounded uppercase font-mono"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          >
            {row.status}
          </span>
        </div>

        <div className="mt-6 grid sm:grid-cols-2 gap-4 text-sm">
          <Field label="Buyer" value={row.userId} mono />
          <Field label="Workload" value={row.workloadType ?? '—'} />
          <Field label="Tier" value={row.tier ?? 'ON_DEMAND'} />
          <Field
            label="Tx confirmed"
            value={row.txConfirmed ? 'yes' : 'no'}
          />
          <Field
            label="Allocated nodes"
            value={row.allocatedNodeIds?.length ? row.allocatedNodeIds.join(', ') : '—'}
            mono
          />
          <Field label="Allocation method" value={row.allocationMethod ?? '—'} />
          <Field label="Requested" value={new Date(row.requestedAt).toLocaleString()} />
          <Field
            label="Expires"
            value={row.expiresAt ? new Date(row.expiresAt).toLocaleString() : '—'}
          />
          {row.purpose && (
            <div className="sm:col-span-2">
              <Field label="Purpose" value={row.purpose} />
            </div>
          )}
          {row.eligibilityFlags?.length > 0 && (
            <div className="sm:col-span-2">
              <div className="text-xs opacity-60 mb-1">Eligibility flags</div>
              <div className="flex flex-wrap gap-1">
                {row.eligibilityFlags.map((f) => (
                  <span
                    key={f}
                    className="text-2xs px-1.5 py-0.5 rounded uppercase font-mono"
                    style={{
                      background: 'rgba(245, 158, 11, 0.12)',
                      color: 'var(--warn)',
                    }}
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
          {row.adminNote && (
            <div className="sm:col-span-2">
              <Field label="Admin note" value={row.adminNote} />
            </div>
          )}
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
            <Button onClick={() => call('approve', 'PATCH')} disabled={!!busy}>
              <Check size={14} />
              <span className="ml-1.5">Approve</span>
            </Button>
          )}
          {canAutoAllocate && (
            <Button
              onClick={() => call('auto-allocate', 'POST')}
              disabled={!!busy}
              variant="ghost"
            >
              <Zap size={14} />
              <span className="ml-1.5">Auto-allocate</span>
            </Button>
          )}
          {canReleaseHold && (
            <Button
              onClick={() => call('release-hold', 'POST')}
              disabled={!!busy}
              variant="ghost"
            >
              <Unlock size={14} />
              <span className="ml-1.5">Release hold</span>
            </Button>
          )}
          {canReject && (
            <Button
              onClick={() => setRejectModal({ reason: '' })}
              disabled={!!busy}
              variant="danger"
            >
              <X size={14} />
              <span className="ml-1.5">Reject + Refund</span>
            </Button>
          )}
          {!canApprove && !canReject && !canAutoAllocate && !canReleaseHold && (
            <div className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
              No admin actions available for status {row.status}.
            </div>
          )}
        </div>
        <div className="mt-4 text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
          Manual node-id allocation and activation flows still go through the
          allocator + agent path. Use auto-allocate to trigger the normal
          routing logic.
        </div>
      </div>

      <Modal open={!!rejectModal} onClose={() => setRejectModal(null)} title="Reject compute request">
        {rejectModal && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Rejecting marks the request CANCELLED and refunds the buyer&apos;s
              payment (USDC or internal balance) automatically.
            </p>
            <textarea
              value={rejectModal.reason}
              onChange={(e) => setRejectModal({ reason: e.target.value })}
              placeholder="Reason (visible to buyer)"
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
                onClick={() => call('reject', 'PATCH', { reason: rejectModal.reason.trim() })}
                disabled={!!busy || rejectModal.reason.trim().length === 0}
                variant="danger"
              >
                Reject + Refund
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
        className={`text-sm ${mono ? 'font-mono break-all' : ''}`}
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  )
}
