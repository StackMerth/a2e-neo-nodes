'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'

interface Deployment {
  id: string
  nodeRunnerName: string
  walletAddress: string
  gpuTier: string
  nodeCount: number
  amount: number
  currency: string
  txHash: string | null
  status: string
  provisionId: string | null
  nodeId: string | null
  createdAt: string
  updatedAt: string
}

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
      setDeployments(data.deployments)
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
  const deployingCount = deployments.filter(d => d.status === 'DEPLOYING').length
  const provisionedCount = deployments.filter(d => d.status === 'PROVISIONED').length
  const cancelledCount = deployments.filter(d => d.status === 'CANCELLED').length

  function getStatusBadge(status: string) {
    switch (status) {
      case 'DEPLOYMENT_REQUESTED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning">
            Pending
          </span>
        )
      case 'DEPLOYING':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent-purple/10 text-accent-purple flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-purple opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-purple" />
            </span>
            Deploying
          </span>
        )
      case 'PROVISIONED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent">
            Provisioned
          </span>
        )
      case 'CANCELLED':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted">
            Cancelled
          </span>
        )
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-text-muted/10 text-text-muted">
            {status}
          </span>
        )
    }
  }

  if (loading && deployments.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-accent text-white px-4 py-3 rounded-lg shadow-lg animate-scaleIn">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-text-primary">Deployment Requests</h1>
          {pendingCount > 0 && (
            <span className="px-2.5 py-1 text-sm font-semibold bg-warning/10 text-warning rounded-full">
              {pendingCount} pending
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-3 text-error/70 hover:text-error underline text-sm"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'DEPLOYMENT_REQUESTED' ? 'border-warning' : 'border-border hover:border-warning/50'
          }`}
          onClick={() => setFilter(filter === 'DEPLOYMENT_REQUESTED' ? 'all' : 'DEPLOYMENT_REQUESTED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-warning/10 rounded-lg flex items-center justify-center">
              <ClockIcon className="w-5 h-5 text-warning" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Pending</p>
              <p className="text-2xl font-bold text-warning">{pendingCount}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'DEPLOYING' ? 'border-accent-purple' : 'border-border hover:border-accent-purple/50'
          }`}
          onClick={() => setFilter(filter === 'DEPLOYING' ? 'all' : 'DEPLOYING')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-purple/10 rounded-lg flex items-center justify-center">
              <RocketIcon className="w-5 h-5 text-accent-purple" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Deploying</p>
              <p className="text-2xl font-bold text-accent-purple">{deployingCount}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'PROVISIONED' ? 'border-accent' : 'border-border hover:border-accent/50'
          }`}
          onClick={() => setFilter(filter === 'PROVISIONED' ? 'all' : 'PROVISIONED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent/10 rounded-lg flex items-center justify-center">
              <CheckIcon className="w-5 h-5 text-accent" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Provisioned</p>
              <p className="text-2xl font-bold text-accent">{provisionedCount}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'CANCELLED' ? 'border-text-muted' : 'border-border hover:border-text-muted/50'
          }`}
          onClick={() => setFilter(filter === 'CANCELLED' ? 'all' : 'CANCELLED')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-text-muted/10 rounded-lg flex items-center justify-center">
              <XCircleIcon className="w-5 h-5 text-text-muted" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Cancelled</p>
              <p className="text-2xl font-bold text-text-muted">{cancelledCount}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Pending Alert */}
      {pendingCount > 0 && filter === 'all' && (
        <div className="bg-warning/10 border border-warning/20 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 bg-warning/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <AlertIcon className="w-4 h-4 text-warning" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary">
                {pendingCount} deployment{pendingCount !== 1 ? 's' : ''} awaiting SSH credentials
              </h3>
              <p className="text-text-muted text-sm mt-1">
                These node runners have requested deployments. Add SSH credentials to start provisioning.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Status Filter Pills */}
      <div className="flex items-center gap-2">
        {STATUS_FILTERS.map((sf) => {
          const count =
            sf.value === 'all' ? deployments.length
            : sf.value === 'DEPLOYMENT_REQUESTED' ? pendingCount
            : sf.value === 'DEPLOYING' ? deployingCount
            : sf.value === 'PROVISIONED' ? provisionedCount
            : cancelledCount
          return (
            <button
              key={sf.value}
              onClick={() => setFilter(sf.value)}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                filter === sf.value
                  ? 'bg-accent text-white'
                  : 'bg-surface border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              {sf.label}
              <span className={`ml-1.5 ${filter === sf.value ? 'text-white/70' : 'text-text-muted'}`}>
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Deployments Table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {filter === 'all' ? 'All Deployments' : `${STATUS_FILTERS.find(f => f.value === filter)?.label} Deployments`}
          </h2>
          {filter !== 'all' && (
            <button
              onClick={() => setFilter('all')}
              className="text-sm text-accent hover:underline"
            >
              Show all
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-hover">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Node Runner</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">GPU Tier</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Nodes</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">TX Hash</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Date</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deployments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-text-muted">
                    No deployments found
                  </td>
                </tr>
              ) : (
                deployments.map((dep) => (
                  <tr key={dep.id} className="hover:bg-surface-hover transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-text-primary">{dep.nodeRunnerName}</p>
                      <code className="text-xs text-text-muted">
                        {dep.walletAddress.slice(0, 8)}...{dep.walletAddress.slice(-6)}
                      </code>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm font-medium">
                        {dep.gpuTier}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-text-primary font-medium">
                      {dep.nodeCount}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-text-primary font-medium">
                        ${dep.amount.toLocaleString()}
                      </span>
                      <span className="text-text-muted text-sm block">{dep.currency}</span>
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(dep.status)}
                    </td>
                    <td className="px-6 py-4">
                      {dep.txHash ? (
                        <a
                          href={`https://solscan.io/tx/${dep.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline font-mono text-sm"
                        >
                          {dep.txHash.slice(0, 8)}...
                        </a>
                      ) : (
                        <span className="text-text-muted">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-text-muted text-sm">
                      {new Date(dep.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {dep.status === 'DEPLOYMENT_REQUESTED' && (
                          <>
                            <button
                              onClick={() => openSshModal(dep)}
                              className="px-3 py-1.5 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors"
                            >
                              Add SSH &amp; Deploy
                            </button>
                            <button
                              onClick={() => handleCancel(dep.id)}
                              disabled={cancellingId === dep.id}
                              className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors disabled:opacity-50"
                            >
                              {cancellingId === dep.id ? 'Cancelling...' : 'Cancel'}
                            </button>
                          </>
                        )}
                        {dep.status === 'DEPLOYING' && (
                          <>
                            {dep.provisionId ? (
                              <Link
                                href={`/nodes?provisionId=${dep.provisionId}`}
                                className="px-3 py-1.5 text-sm bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 rounded-lg transition-colors flex items-center gap-1.5"
                              >
                                <span className="relative flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-purple opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-purple" />
                                </span>
                                View Progress
                              </Link>
                            ) : (
                              <span className="px-3 py-1.5 text-sm text-accent-purple/70">
                                Provisioning...
                              </span>
                            )}
                            <button
                              onClick={() => handleCancel(dep.id)}
                              disabled={cancellingId === dep.id}
                              className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors disabled:opacity-50"
                            >
                              {cancellingId === dep.id ? 'Cancelling...' : 'Cancel'}
                            </button>
                          </>
                        )}
                        {dep.status === 'PROVISIONED' && dep.nodeId && (
                          <Link
                            href={`/nodes/${dep.nodeId}`}
                            className="text-accent hover:underline text-sm"
                          >
                            View Node
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
            <span className="text-text-primary font-medium">{selectedDeployment?.nodeRunnerName}</span>
            {' '}&mdash;{' '}
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

          {/* Conditional Auth Fields */}
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

          {/* Test Mode */}
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
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submittingSsh ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Starting...
                </>
              ) : (
                'Start Provisioning'
              )}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function RocketIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
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

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}
