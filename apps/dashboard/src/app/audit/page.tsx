'use client'

import { useState, useEffect } from 'react'
import {
  ClipboardCheck, RefreshCw, FileText, Clock, CircleCheck, XCircle, ExternalLink, List,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  MetricTriad,
  DataTableCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

interface AuditLog {
  id: string
  entityType: string
  entityId: string
  action: string
  previousValue: Record<string, unknown> | null
  newValue: Record<string, unknown> | null
  actor: string | null
  actorType: string
  reason: string | null
  createdAt: string
}

type AuditLogRow = AuditLog & Record<string, unknown>

interface ReconciliationStatus {
  pending: number
  verified: number
  failed: number
  notFound: number
  manual: number
  lastRunAt: string | null
  totalProcessed: number
}

interface PendingReconciliation {
  id: string
  txHash: string
  settlementId: string | null
  paymentId: string | null
  expectedAmount: number
  recipientAddress: string
  status: string
  attempts: number
  lastAttemptAt: string | null
  errorMessage: string | null
  createdAt: string
  resolvedAt: string | null
}

type ReconRow = PendingReconciliation & Record<string, unknown>

export default function AuditPage() {
  const { addToast } = useToast()
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [reconciliationStatus, setReconciliationStatus] = useState<ReconciliationStatus | null>(null)
  const [pendingReconciliations, setPendingReconciliations] = useState<PendingReconciliation[]>([])
  const [loading, setLoading] = useState(true)
  const [runningReconciliation, setRunningReconciliation] = useState(false)
  const [entityFilter, setEntityFilter] = useState<string>('all')
  const [activeTab, setActiveTab] = useState<'audit' | 'reconciliation'>('audit')

  useEffect(() => {
    loadData()
  }, [entityFilter])

  async function loadData() {
    setLoading(true)
    try {
      const [auditRes, reconcileStatusRes, pendingRes] = await Promise.all([
        api.audit.list({
          entityType: entityFilter !== 'all' ? entityFilter : undefined,
          limit: 50,
        }),
        api.reconciliation.status(),
        api.reconciliation.pending({ limit: 50 }),
      ])
      setAuditLogs(auditRes.logs)
      setReconciliationStatus(reconcileStatusRes)
      setPendingReconciliations(pendingRes.records)
    } catch (err) {
      console.error('Failed to load audit data:', err)
      addToast({ type: 'error', title: 'Error', message: 'Failed to load audit data' })
    } finally {
      setLoading(false)
    }
  }

  async function handleRunReconciliation() {
    setRunningReconciliation(true)
    try {
      const result = await api.reconciliation.run()
      addToast({
        type: 'success',
        title: 'Reconciliation Complete',
        message: `Processed: ${result.result.processed}, Verified: ${result.result.verified}, Failed: ${result.result.failed}`,
      })
      loadData()
    } catch (err) {
      addToast({ type: 'error', title: 'Error', message: err instanceof Error ? err.message : 'Reconciliation failed' })
    } finally {
      setRunningReconciliation(false)
    }
  }

  const getActionBadge = (action: string) => {
    const styles: Record<string, string> = {
      CREATE: 'bg-accent/10 text-accent border-accent/20',
      UPDATE: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      STATUS_CHANGE: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
      DELETE: 'bg-error/10 text-error border-error/20',
      PAYMENT_SENT: 'bg-accent/10 text-accent border-accent/20',
      PAYMENT_FAILED: 'bg-error/10 text-error border-error/20',
    }
    return (
      <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded ${styles[action] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
        {action}
      </span>
    )
  }

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      PENDING: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      VERIFIED: 'bg-accent/10 text-accent border-accent/20',
      FAILED: 'bg-error/10 text-error border-error/20',
      NOT_FOUND: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
      MANUAL: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    }
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium border rounded ${styles[status] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
        {status}
      </span>
    )
  }

  const metrics: MetricCardData[] = [
    { label: 'Total Entries', value: auditLogs.length, icon: FileText, tone: 'purple' },
    { label: 'Pending Recon', value: reconciliationStatus?.pending ?? 0, icon: Clock, tone: 'orange' },
    { label: 'Verified', value: reconciliationStatus?.verified ?? 0, icon: CircleCheck, tone: 'green' },
  ]

  const auditColumns: Array<DataTableColumn<AuditLogRow>> = [
    {
      key: 'createdAt',
      header: 'Timestamp',
      mono: true,
      render: (log) => (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {new Date(log.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'entityType',
      header: 'Entity',
      render: (log) => (
        <div>
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{log.entityType}</span>
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{log.entityId.substring(0, 12)}...</p>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (log) => getActionBadge(log.action),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (log) => (
        <div>
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{log.actor || 'System'}</span>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{log.actorType}</p>
        </div>
      ),
    },
    {
      key: 'newValue',
      header: 'Changes',
      render: (log) => (
        <div className="max-w-xs">
          {log.previousValue && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <span className="text-error">-</span> {JSON.stringify(log.previousValue).substring(0, 50)}...
            </p>
          )}
          {log.newValue && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <span className="text-accent">+</span> {JSON.stringify(log.newValue).substring(0, 50)}...
            </p>
          )}
        </div>
      ),
    },
  ]

  const reconColumns: Array<DataTableColumn<ReconRow>> = [
    {
      key: 'txHash',
      header: 'TX Hash',
      mono: true,
      render: (rec) => (
        <a
          href={`https://solscan.io/tx/${rec.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs hover:underline flex items-center gap-1"
          style={{ color: 'var(--primary)' }}
        >
          {rec.txHash.substring(0, 16)}...
          <ExternalLink className="w-3 h-3" />
        </a>
      ),
    },
    {
      key: 'expectedAmount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (rec) => `$${rec.expectedAmount.toFixed(2)}`,
    },
    {
      key: 'recipientAddress',
      header: 'Recipient',
      mono: true,
      render: (rec) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {rec.recipientAddress.substring(0, 8)}...{rec.recipientAddress.slice(-4)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (rec) => getStatusBadge(rec.status),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      mono: true,
      render: (rec) => rec.attempts,
    },
    {
      key: 'createdAt',
      header: 'Created',
      mono: true,
      render: (rec) => (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {new Date(rec.createdAt).toLocaleString()}
        </span>
      ),
    },
  ]

  const tabsAndActions = (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex gap-1 p-1 rounded-md" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
        <button
          onClick={() => setActiveTab('audit')}
          className="px-3 py-1 text-xs font-medium rounded transition-colors"
          style={activeTab === 'audit'
            ? { background: 'var(--primary)', color: '#fff' }
            : { color: 'var(--text-secondary)' }
          }
        >
          Audit Logs
        </button>
        <button
          onClick={() => setActiveTab('reconciliation')}
          className="px-3 py-1 text-xs font-medium rounded transition-colors"
          style={activeTab === 'reconciliation'
            ? { background: 'var(--primary)', color: '#fff' }
            : { color: 'var(--text-secondary)' }
          }
        >
          Reconciliation
        </button>
      </div>
      <Button
        onClick={handleRunReconciliation}
        disabled={runningReconciliation}
        variant="primary"
        size="sm"
      >
        {runningReconciliation ? 'Running...' : 'Run Reconciliation'}
      </Button>
    </div>
  )

  const auditFilterPills = (
    <div className="flex items-center gap-2 flex-wrap">
      {['all', 'Payment', 'Settlement', 'Investment'].map(type => {
        const isActive = entityFilter === type
        return (
          <button
            key={type}
            onClick={() => setEntityFilter(type)}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {type === 'all' ? 'All' : type}
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="Audit & Reconciliation"
      subtitle="Financial state change history and on-chain verification"
      onRefresh={loadData}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        <MetricTriad metrics={metrics} />

        {tabsAndActions}

        {activeTab === 'audit' ? (
          <DataTableCard<AuditLogRow>
            title="Audit Trail"
            icon={List}
            actions={auditFilterPills}
            columns={auditColumns}
            rows={auditLogs as AuditLogRow[]}
            loading={loading && auditLogs.length === 0}
            empty={
              <div className="text-center py-8">
                <ClipboardCheck className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>No audit logs found</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Audit logs will appear here when financial state changes occur
                </p>
              </div>
            }
          />
        ) : (
          <DataTableCard<ReconRow>
            title="Pending Reconciliations"
            icon={Clock}
            badge={
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                ({pendingReconciliations.length} awaiting verification)
              </span>
            }
            columns={reconColumns}
            rows={pendingReconciliations as ReconRow[]}
            loading={loading && pendingReconciliations.length === 0}
            empty={
              <div className="text-center py-8">
                <CircleCheck className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>All caught up</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  No pending reconciliations at this time
                </p>
              </div>
            }
          />
        )}
      </div>
    </DashboardShell>
  )
}
