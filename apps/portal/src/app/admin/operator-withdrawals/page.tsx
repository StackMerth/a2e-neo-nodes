'use client'

import { useEffect, useState } from 'react'
import { ArrowUpToLine, ExternalLink } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface OperatorWithdrawalRow {
  id: string
  nodeRunnerId: string
  amount: number
  currency: string
  status: 'PENDING' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED'
  payoutMethod: 'SOLANA' | 'STRIPE_CONNECT'
  walletAddress: string | null
  txHash: string | null
  requestedAt: string
  processedAt: string | null
  nodeRunner: {
    id: string
    name: string
    email: string | null
    walletAddress: string | null
  } | null
}

type Row = OperatorWithdrawalRow & Record<string, unknown>

const STATUS_COLORS: Record<OperatorWithdrawalRow['status'], { bg: string; text: string }> = {
  PENDING: { bg: 'rgba(245, 158, 11, 0.12)', text: 'var(--warn)' },
  APPROVED: { bg: 'rgba(139, 92, 246, 0.12)', text: '#8b5cf6' },
  PROCESSING: { bg: 'rgba(6, 182, 212, 0.12)', text: '#06b6d4' },
  COMPLETED: { bg: 'rgba(34, 197, 94, 0.12)', text: 'var(--primary)' },
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

export default function AdminOperatorWithdrawalsPage() {
  const { toast } = useToast()
  const [rows, setRows] = useState<OperatorWithdrawalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | OperatorWithdrawalRow['status']>('PENDING')

  useEffect(() => {
    void load()
  }, [filter])

  async function load() {
    setLoading(true)
    try {
      const q = filter === 'ALL' ? '' : `?status=${filter}`
      const data = await apiFetch<{ withdrawals: OperatorWithdrawalRow[] }>(
        `/v1/admin/withdrawals${q}&limit=50`.replace('?&', '?'),
      )
      setRows(data.withdrawals)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  const columns: DataTableColumn<Row>[] = [
    {
      key: 'requestedAt',
      header: 'Requested',
      mono: true,
      render: (r) => timeAgo(r.requestedAt),
    },
    {
      key: 'nodeRunner',
      header: 'Operator',
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {r.nodeRunner?.name ?? '(unnamed)'}
          </span>
          <span className="text-2xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
            {r.nodeRunner?.email ?? r.nodeRunnerId}
          </span>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      mono: true,
      align: 'right',
      render: (r) => (
        <span style={{ color: 'var(--primary)' }}>${r.amount.toFixed(2)}</span>
      ),
    },
    {
      key: 'payoutMethod',
      header: 'Method',
      render: (r) => (
        <span className="text-2xs uppercase font-mono opacity-70">
          {r.payoutMethod === 'STRIPE_CONNECT' ? 'Stripe' : 'Solana'}
        </span>
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
      key: 'txHash',
      header: '',
      align: 'right',
      render: (r) =>
        r.txHash ? (
          <a
            href={`https://solscan.io/tx/${r.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs inline-flex items-center gap-1 opacity-70 hover:opacity-100"
            style={{ color: 'var(--primary)' }}
            title={r.txHash}
          >
            <ExternalLink size={12} /> tx
          </a>
        ) : (
          <span className="text-2xs opacity-40">—</span>
        ),
    },
  ]

  return (
    <DashboardShell
      title="Operator Withdrawals"
      subtitle="Node-runner payout requests (multi-step admin flow via API)"
    >
      <div className="lg:col-span-3 space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'ALL'] as const).map((f) => (
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

        <DataTableCard<Row>
          title="Operator payout queue"
          icon={ArrowUpToLine}
          columns={columns}
          rows={(rows ?? []) as Row[]}
          loading={loading}
          empty={
            <EmptyState
              icon={ArrowUpToLine}
              title="No operator withdrawals"
              description="Operator payout requests will appear here when filed."
            />
          }
        />

        <div
          className="rounded-lg p-4 text-2xs"
          style={{
            background: 'rgba(245, 158, 11, 0.06)',
            border: '1px solid rgba(245, 158, 11, 0.25)',
            color: 'var(--text-secondary)',
          }}
        >
          <strong style={{ color: 'var(--warn)' }}>Action endpoints</strong> for
          this queue (approve, process, process-stripe, complete, reject) live at
          <span className="font-mono"> PATCH /v1/admin/withdrawals/:id/&lt;action&gt; </span>
          and are fully working. UI buttons for them are a follow-up. For now,
          use the API directly or curl.
        </div>
      </div>
    </DashboardShell>
  )
}
