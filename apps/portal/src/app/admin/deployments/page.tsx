'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Server } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface DeploymentRow {
  id: string
  status: string
  nodeRunnerId: string | null
  gpuTier: string
  totalSteps: number
  currentStep: number
  currentAction: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

type Row = DeploymentRow & Record<string, unknown>

function timeAgo(d: string | null): string {
  if (!d) return '—'
  const seconds = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default function AdminDeploymentsPage() {
  const { toast } = useToast()
  const router = useRouter()
  const [rows, setRows] = useState<DeploymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'>(
    'PENDING',
  )

  useEffect(() => {
    void load()
  }, [filter])

  async function load() {
    setLoading(true)
    try {
      const q = filter === 'ALL' ? '' : `?status=${filter}`
      const data = await apiFetch<{ deployments: DeploymentRow[] }>(
        `/v1/admin/deployments${q}&limit=100`.replace('?&', '?'),
      )
      setRows(data.deployments)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  const columns: DataTableColumn<Row>[] = [
    {
      key: 'createdAt',
      header: 'Created',
      mono: true,
      render: (r) => timeAgo(r.createdAt),
    },
    {
      key: 'nodeRunnerId',
      header: 'Operator',
      mono: true,
      render: (r) => r.nodeRunnerId ?? '—',
    },
    {
      key: 'gpuTier',
      header: 'GPU',
      render: (r) => r.gpuTier,
    },
    {
      key: 'currentStep',
      header: 'Progress',
      render: (r) => (
        <span className="text-xs font-mono">
          {r.currentStep}/{r.totalSteps}
        </span>
      ),
    },
    {
      key: 'currentAction',
      header: 'Action',
      render: (r) => (
        <span className="text-2xs opacity-70" style={{ color: 'var(--text-secondary)' }}>
          {r.currentAction ?? '—'}
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
    {
      key: 'error',
      header: 'Error',
      render: (r) =>
        r.error ? (
          <span className="text-2xs truncate max-w-[200px] block" style={{ color: 'var(--danger)' }}>
            {r.error}
          </span>
        ) : (
          <span className="text-2xs opacity-40">—</span>
        ),
    },
  ]

  return (
    <DashboardShell
      title="Deployments"
      subtitle="Operator node provisioning jobs"
    >
      <div className="lg:col-span-3 space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ALL'] as const).map((f) => (
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
          title="Deployment queue"
          icon={Server}
          columns={columns}
          rows={(rows ?? []) as Row[]}
          loading={loading}
          onRowClick={(r) => router.push(`/admin/deployments/${r.id}`)}
          empty={
            <EmptyState
              icon={Server}
              title="No deployments"
              description="Operator node provisioning jobs will appear here."
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
