'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Server, X, Loader2, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

interface Deployment {
  id: string
  nodeRunnerId: string
  amount: number
  status: string
  gpuTier: string
  txHash: string | null
  createdAt: string
  confirmedAt: string | null
  provisionedAt: string | null
  failedAt: string | null
  failureReason: string | null
  nodeRunner: {
    id: string
    name: string
    email: string | null
    walletAddress: string | null
    userId: string | null
  } | null
}

interface ProvisionJob {
  id: string
  status: string
  host: string
  port: number
  username: string
  totalSteps: number
  currentStep: number
  currentAction: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

interface DetailResponse {
  deployment: Deployment
  provisionJob: ProvisionJob | null
  node: { id: string; walletAddress: string; status: string; gpuTier: string } | null
}

export default function AdminDeploymentDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { toast } = useToast()
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [cancelModal, setCancelModal] = useState<{ reason: string } | null>(null)

  useEffect(() => {
    if (params?.id) void load(params.id)
  }, [params?.id])

  async function load(id: string) {
    setLoading(true)
    try {
      const d = await apiFetch<DetailResponse>(`/v1/admin/deployments/${id}`)
      setData(d)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function cancel(reason: string) {
    if (!data?.deployment) return
    setBusy('cancel')
    try {
      await apiFetch(`/v1/admin/deployments/${data.deployment.id}/cancel`, {
        method: 'PATCH',
        body: { reason },
      })
      toast('success', 'Cancelled + refunded')
      setCancelModal(null)
      await load(data.deployment.id)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Cancel failed')
    } finally {
      setBusy(null)
    }
  }

  async function complete() {
    if (!data?.deployment) return
    if (!confirm('Mark this deployment COMPLETED and link the provisioned node?')) return
    setBusy('complete')
    try {
      await apiFetch(`/v1/admin/deployments/${data.deployment.id}/complete`, {
        method: 'POST',
      })
      toast('success', 'Marked completed')
      await load(data.deployment.id)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Complete failed')
    } finally {
      setBusy(null)
    }
  }

  if (loading || !data?.deployment) {
    return (
      <div className="min-h-[400px] flex items-center justify-center">
        <Loader2 size={28} className="animate-spin opacity-60" />
      </div>
    )
  }

  const dep = data.deployment
  const job = data.provisionJob
  const node = data.node

  const canCancel = !['COMPLETED', 'FAILED', 'CANCELLED', 'PROVISIONED'].includes(dep.status)
  const canComplete = dep.status === 'AWAITING_PROVISION' || dep.status === 'DEPLOYING'

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <button
        onClick={() => router.push('/admin/deployments')}
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
              style={{ background: 'rgba(139, 92, 246, 0.12)' }}
            >
              <Server size={20} style={{ color: '#8b5cf6' }} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                {dep.gpuTier} · ${dep.amount.toFixed(2)}
              </h1>
              <p className="text-sm opacity-70" style={{ color: 'var(--text-secondary)' }}>
                {dep.nodeRunner?.name ?? '(unnamed)'}
                {dep.nodeRunner?.email ? ` · ${dep.nodeRunner.email}` : ''}
              </p>
            </div>
          </div>
          <span
            className="text-xs px-2 py-1 rounded uppercase font-mono"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          >
            {dep.status}
          </span>
        </div>

        <div className="mt-6 grid sm:grid-cols-2 gap-4 text-sm">
          <Field label="Created" value={new Date(dep.createdAt).toLocaleString()} />
          <Field
            label="Confirmed"
            value={dep.confirmedAt ? new Date(dep.confirmedAt).toLocaleString() : '—'}
          />
          <Field
            label="Provisioned"
            value={dep.provisionedAt ? new Date(dep.provisionedAt).toLocaleString() : '—'}
          />
          <Field
            label="Failed"
            value={dep.failedAt ? new Date(dep.failedAt).toLocaleString() : '—'}
          />
          {dep.failureReason && (
            <div className="sm:col-span-2">
              <Field label="Failure reason" value={dep.failureReason} />
            </div>
          )}
          <Field label="TX hash" value={dep.txHash ?? '—'} mono />
          <Field label="Operator wallet" value={dep.nodeRunner?.walletAddress ?? '—'} mono />
        </div>
      </div>

      {job && (
        <div
          className="rounded-2xl p-6"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
        >
          <div className="text-sm font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
            Provision job
          </div>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <Field label="Status" value={job.status} />
            <Field label="Progress" value={`${job.currentStep}/${job.totalSteps}`} />
            <Field label="Host" value={`${job.host}:${job.port}`} mono />
            <Field label="Username" value={job.username} mono />
            <Field label="Current action" value={job.currentAction ?? '—'} />
            {job.error && (
              <div className="sm:col-span-2">
                <Field label="Error" value={job.error} />
              </div>
            )}
          </div>
        </div>
      )}

      {node && (
        <div
          className="rounded-2xl p-6"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
        >
          <div className="text-sm font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
            Provisioned node
          </div>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <Field label="Node id" value={node.id} mono />
            <Field label="GPU tier" value={node.gpuTier} />
            <Field label="Status" value={node.status} />
            <Field label="Wallet" value={node.walletAddress} mono />
          </div>
        </div>
      )}

      <div
        className="rounded-2xl p-6"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
      >
        <div className="text-sm font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
          Actions
        </div>
        <div className="flex flex-wrap gap-2">
          {canComplete && (
            <Button onClick={complete} disabled={!!busy}>
              {busy === 'complete' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CheckCircle2 size={14} />
              )}
              <span className="ml-1.5">Mark Completed</span>
            </Button>
          )}
          {canCancel && (
            <Button
              onClick={() => setCancelModal({ reason: '' })}
              disabled={!!busy}
              variant="danger"
            >
              <X size={14} />
              <span className="ml-1.5">Cancel + Refund</span>
            </Button>
          )}
          {!canCancel && !canComplete && (
            <div className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
              No admin actions available for status {dep.status}.
            </div>
          )}
        </div>
      </div>

      <Modal open={!!cancelModal} onClose={() => setCancelModal(null)} title="Cancel deployment">
        {cancelModal && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Cancelling refunds the operator&apos;s deposit and marks the
              investment CANCELLED. Reason is shown in the notification.
            </p>
            <textarea
              value={cancelModal.reason}
              onChange={(e) => setCancelModal({ reason: e.target.value })}
              placeholder="Reason"
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
              <Button variant="ghost" onClick={() => setCancelModal(null)}>
                Close
              </Button>
              <Button
                onClick={() => cancel(cancelModal.reason.trim())}
                disabled={!!busy || cancelModal.reason.trim().length === 0}
                variant="danger"
              >
                Cancel + Refund
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
