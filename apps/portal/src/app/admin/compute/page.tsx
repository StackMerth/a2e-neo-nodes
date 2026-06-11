'use client'

import { useEffect, useState } from 'react'
import { Cpu } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface ComputeRequestRow {
  id: string
  userId: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  ratePerDay: number
  totalCost: number
  paymentSource: string
  status: string
  requestedAt: string
  txHash: string | null
}

type Row = ComputeRequestRow & Record<string, unknown>

function timeAgo(d: string | null): string {
  if (!d) return '—'
  const seconds = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default function AdminComputePage() {
  const { toast } = useToast()
  const [rows, setRows] = useState<ComputeRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<
    'ALL' | 'PENDING' | 'WAITLISTED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  >('PENDING')

  useEffect(() => {
    void load()
  }, [filter])

  async function load() {
    setLoading(true)
    try {
      const q = filter === 'ALL' ? '' : `?status=${filter}`
      const data = await apiFetch<{ requests: ComputeRequestRow[] }>(
        `/v1/admin/compute/requests${q}&limit=100`.replace('?&', '?'),
      )
      setRows(data.requests)
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
      key: 'userId',
      header: 'Buyer',
      mono: true,
      render: (r) => r.userId,
    },
    {
      key: 'gpuTier',
      header: 'Config',
      render: (r) => (
        <span>
          {r.gpuCount}× {r.gpuTier}
        </span>
      ),
    },
    {
      key: 'durationDays',
      header: 'Days',
      mono: true,
      align: 'right',
      render: (r) => r.durationDays,
    },
    {
      key: 'totalCost',
      header: 'Cost',
      mono: true,
      align: 'right',
      render: (r) => (
        <span style={{ color: 'var(--primary)' }}>${r.totalCost.toFixed(2)}</span>
      ),
    },
    {
      key: 'paymentSource',
      header: 'Payment',
      render: (r) => (
        <span className="text-2xs uppercase font-mono opacity-70">
          {r.paymentSource}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className="text-2xs uppercase font-mono opacity-80">{r.status}</span>
      ),
    },
  ]

  return (
    <DashboardShell
      title="Compute Requests"
      subtitle="Buyer-side rental requests across all statuses"
    >
      <div className="lg:col-span-3 space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(
            [
              'PENDING',
              'WAITLISTED',
              'ACTIVE',
              'COMPLETED',
              'CANCELLED',
              'ALL',
            ] as const
          ).map((f) => (
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
          title="Compute requests"
          icon={Cpu}
          columns={columns}
          rows={(rows ?? []) as Row[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Cpu}
              title="No compute requests"
              description="Buyer rental requests will appear here."
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
