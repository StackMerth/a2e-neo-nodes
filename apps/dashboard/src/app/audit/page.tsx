'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { ClipboardCheck, RefreshCw, FileText, CreditCard, Banknote, Wallet, List, Clock, CircleCheck, XCircle, HelpCircle, Eye, ExternalLink } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

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
      <span className={`inline-flex items-center px-2.5 py-1 text-xs font-medium border rounded-lg ${styles[action] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
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
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border rounded-lg ${styles[status] || 'bg-gray-500/10 text-gray-400 border-gray-500/20'}`}>
        {status}
      </span>
    )
  }

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Hero Section */}
      <motion.div variants={item} className="relative py-8 md:py-12">
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 via-transparent to-transparent rounded-3xl" />
        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-500/5 border border-indigo-500/20 rounded-full mb-6 animate-slideUp">
            <ClipboardCheck className="w-4 h-4 text-indigo-400" />
            <span className="text-xs text-indigo-400 font-medium uppercase tracking-wider">System Integrity</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-text-primary mb-3">
            Audit & Reconciliation
          </h1>
          <p className="text-text-muted max-w-xl mx-auto">
            Track financial state changes, monitor transaction integrity, and reconcile orphaned payments.
          </p>
        </div>
      </motion.div>

      {/* Actions Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex gap-1 p-1 bg-surface rounded-xl">
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              activeTab === 'audit'
                ? 'bg-accent text-white shadow-lg shadow-accent/20'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Audit Logs
          </button>
          <button
            onClick={() => setActiveTab('reconciliation')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              activeTab === 'reconciliation'
                ? 'bg-accent text-white shadow-lg shadow-accent/20'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }`}
          >
            Reconciliation
          </button>
        </div>
        <Button onClick={loadData} variant="outline" size="sm" icon={<RefreshCw className="w-4 h-4" />}>
          Refresh
        </Button>
      </div>

      {activeTab === 'audit' ? (
        <>
          {/* Audit Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total Logs"
              value={auditLogs.length}
              variant="purple"
              animate
              icon={<FileText className="w-4 h-4" />}
            />
            <StatCard
              label="Payments"
              value={auditLogs.filter(l => l.entityType === 'Payment').length}
              variant="accent"
              animate
              icon={<CreditCard className="w-4 h-4" />}
            />
            <StatCard
              label="Settlements"
              value={auditLogs.filter(l => l.entityType === 'Settlement').length}
              variant="blue"
              animate
              icon={<Banknote className="w-4 h-4" />}
            />
            <StatCard
              label="Investments"
              value={auditLogs.filter(l => l.entityType === 'Investment').length}
              variant="orange"
              animate
              icon={<Wallet className="w-4 h-4" />}
            />
          </div>

          {/* Filter */}
          <div className="flex gap-1 p-1 bg-surface rounded-xl w-fit">
            {['all', 'Payment', 'Settlement', 'Investment'].map((type) => (
              <button
                key={type}
                onClick={() => setEntityFilter(type)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  entityFilter === type
                    ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                {type === 'all' ? 'All' : type}
              </button>
            ))}
          </div>

          {/* Audit Logs Table */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-400 flex items-center justify-center">
                <List className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Audit Trail</h3>
                <p className="text-xs text-text-muted">Financial state change history</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Timestamp</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Entity</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Action</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Actor</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center">
                        <div className="flex flex-col items-center gap-3">
                          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                          <p className="text-text-muted">Loading audit logs...</p>
                        </div>
                      </td>
                    </tr>
                  ) : auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12">
                        <EmptyState
                          icon={<ClipboardCheck className="w-8 h-8" />}
                          title="No audit logs found"
                          description="Audit logs will appear here when financial state changes occur"
                        />
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                        <td className="py-4 px-4">
                          <span className="text-xs text-text-muted">
                            {new Date(log.createdAt).toLocaleString()}
                          </span>
                        </td>
                        <td className="py-4 px-4">
                          <div>
                            <span className="text-sm font-medium text-text-primary">{log.entityType}</span>
                            <p className="text-xs text-text-muted font-mono">{log.entityId.substring(0, 12)}...</p>
                          </div>
                        </td>
                        <td className="py-4 px-4">{getActionBadge(log.action)}</td>
                        <td className="py-4 px-4">
                          <div>
                            <span className="text-sm text-text-primary">{log.actor || 'System'}</span>
                            <p className="text-xs text-text-muted">{log.actorType}</p>
                          </div>
                        </td>
                        <td className="py-4 px-4">
                          <div className="max-w-xs">
                            {log.previousValue && (
                              <p className="text-xs text-text-muted">
                                <span className="text-error">-</span> {JSON.stringify(log.previousValue).substring(0, 50)}...
                              </p>
                            )}
                            {log.newValue && (
                              <p className="text-xs text-text-muted">
                                <span className="text-accent">+</span> {JSON.stringify(log.newValue).substring(0, 50)}...
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <>
          {/* Reconciliation Stats */}
          {reconciliationStatus && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <StatCard
                label="Pending"
                value={reconciliationStatus.pending}
                variant="orange"
                animate
                icon={<Clock className="w-4 h-4" />}
              />
              <StatCard
                label="Verified"
                value={reconciliationStatus.verified}
                variant="accent"
                animate
                icon={<CircleCheck className="w-4 h-4" />}
              />
              <StatCard
                label="Failed"
                value={reconciliationStatus.failed}
                variant="orange"
                animate
                icon={<XCircle className="w-4 h-4" />}
              />
              <StatCard
                label="Not Found"
                value={reconciliationStatus.notFound}
                animate
                icon={<HelpCircle className="w-4 h-4" />}
              />
              <StatCard
                label="Manual Review"
                value={reconciliationStatus.manual}
                variant="purple"
                animate
                icon={<Eye className="w-4 h-4" />}
              />
            </div>
          )}

          {/* Run Reconciliation Button */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                  <RefreshCw className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Manual Reconciliation</h3>
                  <p className="text-sm text-text-muted">
                    Run reconciliation to verify pending transactions on-chain.
                    {reconciliationStatus?.lastRunAt && (
                      <span className="ml-2">
                        Last run: {new Date(reconciliationStatus.lastRunAt).toLocaleString()}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <Button
                onClick={handleRunReconciliation}
                disabled={runningReconciliation}
                variant="primary"
              >
                {runningReconciliation ? 'Running...' : 'Run Reconciliation'}
              </Button>
            </div>
          </Card>

          {/* Pending Reconciliations Table */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-400 flex items-center justify-center">
                <Clock className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Pending Reconciliations</h3>
                <p className="text-xs text-text-muted">{pendingReconciliations.length} transactions awaiting verification</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">TX Hash</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Amount</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Recipient</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Attempts</th>
                    <th className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center">
                        <div className="flex flex-col items-center gap-3">
                          <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
                          <p className="text-text-muted">Loading reconciliations...</p>
                        </div>
                      </td>
                    </tr>
                  ) : pendingReconciliations.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12">
                        <EmptyState
                          icon={<CircleCheck className="w-8 h-8" />}
                          title="All caught up!"
                          description="No pending reconciliations at this time"
                        />
                      </td>
                    </tr>
                  ) : (
                    pendingReconciliations.map((rec) => (
                      <tr key={rec.id} className="border-b border-border/50 hover:bg-surface-hover/50 transition-colors">
                        <td className="py-4 px-4">
                          <a
                            href={`https://solscan.io/tx/${rec.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-mono text-accent hover:underline flex items-center gap-1"
                          >
                            {rec.txHash.substring(0, 16)}...
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </td>
                        <td className="py-4 px-4">
                          <span className="font-semibold text-text-primary">${rec.expectedAmount.toFixed(2)}</span>
                        </td>
                        <td className="py-4 px-4">
                          <span className="text-xs font-mono text-text-secondary">
                            {rec.recipientAddress.substring(0, 8)}...{rec.recipientAddress.slice(-4)}
                          </span>
                        </td>
                        <td className="py-4 px-4">{getStatusBadge(rec.status)}</td>
                        <td className="py-4 px-4">
                          <span className="text-sm text-text-primary">{rec.attempts}</span>
                        </td>
                        <td className="py-4 px-4">
                          <span className="text-xs text-text-muted">
                            {new Date(rec.createdAt).toLocaleString()}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </motion.div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function ClipboardCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

function CreditCardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  )
}

function BanknotesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  )
}

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  )
}

function ListIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
    </svg>
  )
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function QuestionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  )
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  )
}
