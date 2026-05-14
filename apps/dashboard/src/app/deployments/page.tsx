'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Rocket, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface Deployment {
  id: string
  nodeRunnerId: string
  gpuTier: string
  nodeCount: number
  amount: number
  currency: string
  txHash: string | null
  status: string
  nodeId: string | null
  deploymentNote: string | null
  sshHost: string | null
  provisionJobId: string | null
  createdAt: string
  nodeRunner: { id: string; name: string; email: string | null; walletAddress: string } | null
}

type DeploymentRow = Deployment & Record<string, unknown>

type StatusFilter = 'all' | 'DEPLOYMENT_REQUESTED' | 'DEPLOYING' | 'PROVISIONED' | 'CANCELLED'

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'DEPLOYMENT_REQUESTED' },
  { label: 'Deploying', value: 'DEPLOYING' },
  { label: 'Provisioned', value: 'PROVISIONED' },
  { label: 'Cancelled', value: 'CANCELLED' },
]

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [toast, setToast] = useState<string | null>(null)

  // SSH modal state
  const [sshModalOpen, setSshModalOpen] = useState(false)
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null)
  const [sshData, setSshData] = useState({
    host: '',
    port: 22,
    username: 'root',
    authMethod: 'password' as 'password' | 'privateKey',
    password: '',
    privateKey: '',
    testMode: false,
  })
  const [submittingSsh, setSubmittingSsh] = useState(false)

  // Cancel state
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const loadDeployments = useCallback(async () => {
    try {
      setLoading(true)
      const status = filter !== 'all' ? filter : undefined
      const data = await api.deployments.list(status)
      setDeployments(data.deployments || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployments')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    loadDeployments()
  }, [loadDeployments])

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      loadDeployments()
    }, 10000)
    return () => clearInterval(interval)
  }, [loadDeployments])

  // Auto-hide toast after 4 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  function openSshModal(deployment: Deployment) {
    setSelectedDeployment(deployment)
    setSshData({
      host: '',
      port: 22,
      username: 'root',
      authMethod: 'password',
      password: '',
      privateKey: '',
      testMode: false,
    })
    setSshModalOpen(true)
  }

  async function handleSubmitSsh(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedDeployment) return

    try {
      setSubmittingSsh(true)
      await api.deployments.submitSsh(selectedDeployment.id, {
        host: sshData.host,
        port: sshData.port,
        username: sshData.username,
        authMethod: sshData.authMethod,
        password: sshData.authMethod === 'password' ? sshData.password : undefined,
        privateKey: sshData.authMethod === 'privateKey' ? sshData.privateKey : undefined,
        testMode: sshData.testMode,
      })
      setSshModalOpen(false)
      setToast('Provisioning started successfully')
      await loadDeployments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit SSH details')
    } finally {
      setSubmittingSsh(false)
    }
  }

  async function handleCancel(id: string) {
    try {
      setCancellingId(id)
      await api.deployments.cancel(id, 'Cancelled by admin')
      setToast('Deployment cancelled')
      await loadDeployments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel deployment')
    } finally {
      setCancellingId(null)
    }
  }

  const pendingCount = deployments.filter(d => d.status === 'DEPLOYMENT_REQUESTED').length

  const getStatusBadgeStyle = (status: string) => {
    switch (status) {
      case 'DEPLOYMENT_REQUESTED': return { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)' }
      case 'DEPLOYING':            return { bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' }
      case 'PROVISIONED':          return { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' }
      case 'CANCELLED':            return { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
      default:                     return { bg: 'var(--bg-card-hover)', color: 'var(--text-muted)' }
    }
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'DEPLOYMENT_REQUESTED': return 'Pending'
      case 'DEPLOYING':            return 'Deploying'
      case 'PROVISIONED':          return 'Provisioned'
      case 'CANCELLED':            return 'Cancelled'
      default:                     return status
    }
  }

  const columns: Array<DataTableColumn<DeploymentRow>> = [
    {
      key: 'nodeRunner',
      header: 'Node Runner',
      render: (d) => (
        <div>
          <p className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{d.nodeRunner?.name}</p>
          <code className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {d.nodeRunner?.walletAddress ? `${d.nodeRunner.walletAddress.slice(0, 8)}...${d.nodeRunner.walletAddress.slice(-6)}` : 'N/A'}
          </code>
        </div>
      ),
    },
    {
      key: 'gpuTier',
      header: 'GPU Tier',
      render: (d) => (
        <span
          className="text-xs font-medium px-2 py-0.5 rounded-full"
          style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success)' }}
        >
          {d.gpuTier}
        </span>
      ),
    },
    {
      key: 'nodeCount',
      header: 'Nodes',
      mono: true,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (d) => (
        <div className="text-right">
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>${d.amount.toLocaleString()}</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{d.currency}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (d) => {
        const ss = getStatusBadgeStyle(d.status)
        return (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: ss.bg, color: ss.color }}>
            {getStatusLabel(d.status)}
          </span>
        )
      },
    },
    {
      key: 'txHash',
      header: 'TX Hash',
      mono: true,
      render: (d) => d.txHash ? (
        <a
          href={`https://solscan.io/tx/${d.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
          style={{ color: 'var(--primary)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {d.txHash.slice(0, 8)}...
        </a>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>-</span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Date',
      align: 'right',
      mono: true,
      render: (d) => new Date(d.createdAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (d) => (
        <div className="flex items-center justify-end gap-2">
          {d.status === 'DEPLOYMENT_REQUESTED' && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); openSshModal(d) }}
                className="px-3 py-1.5 text-xs rounded-md font-medium"
                style={{ background: 'var(--primary)', color: '#fff' }}
              >
                Add SSH
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleCancel(d.id) }}
                disabled={cancellingId === d.id}
                className="px-3 py-1.5 text-xs disabled:opacity-50"
                style={{ color: 'var(--danger)' }}
              >
                {cancellingId === d.id ? 'Cancelling...' : 'Cancel'}
              </button>
            </>
          )}
          {d.status === 'DEPLOYING' && (
            <>
              {d.provisionJobId ? (
                <Link
                  href={`/nodes?provisionId=${d.provisionJobId}`}
                  className="px-3 py-1.5 text-xs rounded-md"
                  style={{ background: 'rgba(139,92,246,0.1)', color: '#8b5cf6' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  View Progress
                </Link>
              ) : (
                <span className="px-3 py-1.5 text-xs" style={{ color: '#8b5cf6' }}>
                  Provisioning...
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); handleCancel(d.id) }}
                disabled={cancellingId === d.id}
                className="px-3 py-1.5 text-xs disabled:opacity-50"
                style={{ color: 'var(--danger)' }}
              >
                {cancellingId === d.id ? 'Cancelling...' : 'Cancel'}
              </button>
            </>
          )}
          {d.status === 'PROVISIONED' && d.nodeId && (
            <Link
              href={`/nodes/${d.nodeId}`}
              className="text-xs hover:underline"
              style={{ color: 'var(--primary)' }}
              onClick={(e) => e.stopPropagation()}
            >
              View Node
            </Link>
          )}
        </div>
      ),
    },
  ]

  const filterBar = (
    <div className="flex items-center gap-1 flex-wrap">
      {STATUS_FILTERS.map((sf) => {
        const isActive = filter === sf.value
        return (
          <button
            key={sf.value}
            onClick={() => setFilter(sf.value)}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {sf.label}
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="Deployments"
      subtitle={pendingCount > 0 ? `${pendingCount} pending` : 'Deployment pipeline'}
      onRefresh={loadDeployments}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        {/* Toast */}
        {toast && (
          <div
            className="fixed top-4 right-4 z-50 px-4 py-3 rounded-md shadow-lg"
            style={{ background: 'var(--primary)', color: '#fff' }}
          >
            {toast}
          </div>
        )}

        {error && (
          <div
            className="px-4 py-3 rounded-md text-sm"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: 'var(--danger)' }}
          >
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-3 underline text-xs"
            >
              Dismiss
            </button>
          </div>
        )}

        {pendingCount > 0 && filter === 'all' && (
          <div
            className="p-4 rounded-md flex items-start gap-3"
            style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}
          >
            <AlertTriangle size={20} style={{ color: 'var(--warning)' }} className="shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {pendingCount} deployment{pendingCount !== 1 ? 's' : ''} awaiting SSH credentials
              </h3>
              <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                These node runners have requested deployments. Add SSH credentials to start provisioning.
              </p>
            </div>
          </div>
        )}

        <DataTableCard<DeploymentRow>
          title={filter === 'all' ? 'All Deployments' : `${STATUS_FILTERS.find(f => f.value === filter)?.label} Deployments`}
          icon={Rocket}
          actions={filterBar}
          columns={columns}
          rows={deployments as DeploymentRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Rocket}
              title="No deployments found"
              description={filter !== 'all' ? 'Try a different status filter.' : 'Deployments will appear here once node runners request them.'}
            />
          }
        />
      </div>

      {/* SSH Details Modal */}
      <Modal
        isOpen={sshModalOpen}
        onClose={() => setSshModalOpen(false)}
        title="Add SSH Credentials & Deploy"
        size="lg"
      >
        <form onSubmit={handleSubmitSsh} className="space-y-4">
          <p className="text-text-muted">
            Provide SSH access to start provisioning for{' '}
            <span className="text-text-primary font-medium">{selectedDeployment?.nodeRunner?.name}</span>
            {' '}-{' '}
            <span className="text-accent font-medium">{selectedDeployment?.gpuTier}</span>
            {' '}({selectedDeployment?.nodeCount} node{(selectedDeployment?.nodeCount ?? 0) !== 1 ? 's' : ''})
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Host *
              </label>
              <input
                type="text"
                value={sshData.host}
                onChange={(e) => setSshData({ ...sshData, host: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="192.168.1.100 or hostname"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Port
              </label>
              <input
                type="number"
                value={sshData.port}
                onChange={(e) => setSshData({ ...sshData, port: parseInt(e.target.value) || 22 })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="22"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Username *
            </label>
            <input
              type="text"
              value={sshData.username}
              onChange={(e) => setSshData({ ...sshData, username: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="root"
              required
            />
          </div>

          {/* Auth Method Toggle */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              Authentication Method
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSshData({ ...sshData, authMethod: 'password' })}
                className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                  sshData.authMethod === 'password'
                    ? 'bg-accent text-white border-accent'
                    : 'bg-surface border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                Password
              </button>
              <button
                type="button"
                onClick={() => setSshData({ ...sshData, authMethod: 'privateKey' })}
                className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                  sshData.authMethod === 'privateKey'
                    ? 'bg-accent text-white border-accent'
                    : 'bg-surface border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
              >
                Private Key
              </button>
            </div>
          </div>

          {sshData.authMethod === 'password' ? (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Password *
              </label>
              <input
                type="password"
                value={sshData.password}
                onChange={(e) => setSshData({ ...sshData, password: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="SSH password"
                required
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Private Key *
              </label>
              <textarea
                value={sshData.privateKey}
                onChange={(e) => setSshData({ ...sshData, privateKey: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                rows={5}
                required
              />
            </div>
          )}

          <div className="flex items-center gap-3 p-3 bg-background border border-border rounded-lg">
            <input
              type="checkbox"
              id="testMode"
              checked={sshData.testMode}
              onChange={(e) => setSshData({ ...sshData, testMode: e.target.checked })}
              className="w-4 h-4 text-accent bg-background border-border rounded focus:ring-accent"
            />
            <label htmlFor="testMode" className="text-sm">
              <span className="text-text-primary font-medium">Test mode</span>
              <span className="text-text-muted block text-xs">
                Simulate provisioning without making real changes to the server
              </span>
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setSshModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submittingSsh}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {submittingSsh ? 'Starting...' : 'Start Provisioning'}
            </button>
          </div>
        </form>
      </Modal>
    </DashboardShell>
  )
}
