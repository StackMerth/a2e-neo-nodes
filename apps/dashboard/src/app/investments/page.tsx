'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Wallet, CircleCheck, Link as LinkIcon, XCircle, Plus,
  Clock as ClockLucide, Server as ServerLucide, AlertTriangle,
  DollarSign,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVar = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface Investment {
  id: string
  nodeRunnerName: string
  walletAddress: string
  amount: number
  currency: string
  cryptoAmount: number | null
  cryptoCurrency: string | null
  txHash: string | null
  gpuTier: string
  status: string
  nodeId: string | null
  createdAt: string
  confirmedAt: string | null
  provisionedAt: string | null
}

export default function InvestmentsPage() {
  const [investments, setInvestments] = useState<Investment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')

  // Confirm payment modal
  const [confirmModalOpen, setConfirmModalOpen] = useState(false)
  const [selectedInvestment, setSelectedInvestment] = useState<Investment | null>(null)
  const [confirmData, setConfirmData] = useState({ txHash: '', cryptoAmount: '', cryptoCurrency: 'SOL' })
  const [confirming, setConfirming] = useState(false)

  // Link node modal
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [nodeId, setNodeId] = useState('')
  const [linking, setLinking] = useState(false)

  // Create investment modal
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [nodeRunners, setNodeRunners] = useState<Array<{ id: string; name: string; walletAddress: string }>>([])
  const [newInvestment, setNewInvestment] = useState({
    nodeRunnerId: '',
    amount: '',
    gpuTier: 'H100',
    txHash: '',
  })
  const [creatingInvestment, setCreatingInvestment] = useState(false)

  // Cancel state
  const [cancelling, setCancelling] = useState<string | null>(null)

  useEffect(() => {
    loadInvestments()
    loadNodeRunners()
  }, [filter])

  async function loadNodeRunners() {
    try {
      const data = await api.nodeRunners.list()
      setNodeRunners(data.nodeRunners.map(nr => ({ id: nr.id, name: nr.name, walletAddress: nr.walletAddress })))
    } catch (err) {
      // Silently fail - node runners are optional for this page
    }
  }

  async function loadInvestments() {
    try {
      setLoading(true)
      const params = filter !== 'all' ? { status: filter } : undefined
      const data = await api.investments.list(params)
      setInvestments(data.investments)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load investments')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmPayment(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedInvestment) return

    try {
      setConfirming(true)
      await api.investments.confirm(selectedInvestment.id, {
        txHash: confirmData.txHash,
        cryptoAmount: confirmData.cryptoAmount ? parseFloat(confirmData.cryptoAmount) : undefined,
        cryptoCurrency: confirmData.cryptoCurrency,
      })
      setConfirmModalOpen(false)
      setConfirmData({ txHash: '', cryptoAmount: '', cryptoCurrency: 'SOL' })
      await loadInvestments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm payment')
    } finally {
      setConfirming(false)
    }
  }

  async function handleLinkNode(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedInvestment) return

    try {
      setLinking(true)
      await api.investments.linkNode(selectedInvestment.id, nodeId)
      setLinkModalOpen(false)
      setNodeId('')
      await loadInvestments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link node')
    } finally {
      setLinking(false)
    }
  }

  async function handleCreateInvestment(e: React.FormEvent) {
    e.preventDefault()
    try {
      setCreatingInvestment(true)
      await api.investments.create({
        nodeRunnerId: newInvestment.nodeRunnerId,
        amount: parseFloat(newInvestment.amount),
        gpuTier: newInvestment.gpuTier,
        txHash: newInvestment.txHash || undefined,
      })
      setCreateModalOpen(false)
      setNewInvestment({ nodeRunnerId: '', amount: '', gpuTier: 'H100', txHash: '' })
      await loadInvestments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create investment')
    } finally {
      setCreatingInvestment(false)
    }
  }

  async function handleCancelInvestment(id: string) {
    try {
      setCancelling(id)
      await api.investments.cancel(id)
      await loadInvestments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel investment')
    } finally {
      setCancelling(null)
    }
  }

  const pendingPayments = investments.filter(i => i.status === 'PENDING')
  const pendingProvisioning = investments.filter(i => i.status === 'PAID')
  const provisioned = investments.filter(i => i.status === 'PROVISIONED')

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    )
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={itemVar} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Investments</h1>
          <p style={{ color: 'var(--text-muted)' }} className="mt-1">Track investments and manage provisioning requests</p>
        </div>
        <button
          onClick={() => setCreateModalOpen(true)}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          <Plus size={20} />
          Add Investment
        </button>
      </motion.div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <motion.div variants={itemVar} className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'PENDING' ? 'border-warning' : 'border-border hover:border-warning/50'
          }`}
          onClick={() => setFilter(filter === 'PENDING' ? 'all' : 'PENDING')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-warning/10 rounded-lg flex items-center justify-center">
              <ClockLucide size={20} style={{ color: 'var(--warning)' }} />
            </div>
            <div>
              <p className="text-text-muted text-sm">Pending Payment</p>
              <p className="text-2xl font-bold text-warning">{pendingPayments.length}</p>
            </div>
          </div>
        </div>

        <div
          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
            filter === 'PAID' ? 'border-accent-purple' : 'border-border hover:border-accent-purple/50'
          }`}
          onClick={() => setFilter(filter === 'PAID' ? 'all' : 'PAID')}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-accent-purple/10 rounded-lg flex items-center justify-center">
              <ServerLucide size={20} className="text-accent-purple" />
            </div>
            <div>
              <p className="text-text-muted text-sm">Awaiting Provisioning</p>
              <p className="text-2xl font-bold text-accent-purple">{pendingProvisioning.length}</p>
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
              <CircleCheck size={20} style={{ color: 'var(--success)' }} />
            </div>
            <div>
              <p className="text-text-muted text-sm">Provisioned</p>
              <p className="text-2xl font-bold text-accent">{provisioned.length}</p>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-text-muted/10 rounded-lg flex items-center justify-center">
              <DollarSign size={20} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div>
              <p className="text-text-muted text-sm">Total Invested</p>
              <p className="text-2xl font-bold text-text-primary">
                ${investments.reduce((sum, i) => sum + i.amount, 0).toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Pending Provisioning Alert */}
      {pendingProvisioning.length > 0 && (
        <div className="bg-accent-purple/10 border border-accent-purple/20 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 bg-accent-purple/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={16} className="text-accent-purple" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary">
                {pendingProvisioning.length} investment{pendingProvisioning.length !== 1 ? 's' : ''} awaiting provisioning
              </h3>
              <p className="text-text-muted text-sm mt-1">
                These node runners have paid and are waiting for their nodes to be set up.
                Contact the data center to get SSH credentials, then provision the nodes.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Investments Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">
            {filter === 'all' ? 'All Investments' : `${filter} Investments`}
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
        <table className="w-full">
          <thead className="bg-surface-hover">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Node Runner</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Amount</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">GPU Tier</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">TX Hash</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase">Date</th>
              <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {investments.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-text-muted">
                  No investments found
                </td>
              </tr>
            ) : (
              investments.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface-hover transition-colors">
                  <td className="px-6 py-4">
                    <p className="font-medium text-text-primary">{inv.nodeRunnerName}</p>
                    <code className="text-xs text-text-muted">
                      {inv.walletAddress.slice(0, 8)}...{inv.walletAddress.slice(-6)}
                    </code>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-text-primary font-medium">${inv.amount.toLocaleString()}</span>
                    {inv.cryptoAmount && (
                      <span className="text-text-muted text-sm block">
                        {inv.cryptoAmount} {inv.cryptoCurrency}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 bg-accent/10 text-accent rounded text-sm font-medium">
                      {inv.gpuTier}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                      inv.status === 'PROVISIONED'
                        ? 'bg-accent/10 text-accent'
                        : inv.status === 'PAID'
                        ? 'bg-accent-purple/10 text-accent-purple'
                        : inv.status === 'PENDING'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-error/10 text-error'
                    }`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {inv.txHash ? (
                      <a
                        href={`https://solscan.io/tx/${inv.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline font-mono text-sm"
                      >
                        {inv.txHash.slice(0, 8)}...
                      </a>
                    ) : (
                      <span className="text-text-muted">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-text-muted text-sm">
                    {new Date(inv.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {inv.status === 'PENDING' && (
                        <>
                          <button
                            onClick={() => {
                              setSelectedInvestment(inv)
                              setConfirmModalOpen(true)
                            }}
                            className="px-3 py-1.5 text-sm bg-warning/10 text-warning hover:bg-warning/20 rounded-lg transition-colors"
                          >
                            Confirm Payment
                          </button>
                          <button
                            onClick={() => handleCancelInvestment(inv.id)}
                            disabled={cancelling === inv.id}
                            className="px-3 py-1.5 text-sm text-error/70 hover:text-error transition-colors disabled:opacity-50"
                          >
                            {cancelling === inv.id ? 'Cancelling...' : 'Cancel'}
                          </button>
                        </>
                      )}
                      {inv.status === 'PAID' && (
                        <Link
                          href={`/nodes?provision=true&investmentId=${inv.id}`}
                          className="px-3 py-1.5 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors"
                        >
                          Provision Node
                        </Link>
                      )}
                      {inv.status === 'PROVISIONED' && inv.nodeId && (
                        <Link
                          href={`/nodes/${inv.nodeId}`}
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

      {/* Confirm Payment Modal */}
      <Modal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title="Confirm Payment"
      >
        <form onSubmit={handleConfirmPayment} className="space-y-4">
          <p className="text-text-muted">
            Confirm that payment has been received from{' '}
            <span className="text-text-primary font-medium">{selectedInvestment?.nodeRunnerName}</span>
            {' '}for <span className="text-accent font-medium">${selectedInvestment?.amount.toLocaleString()}</span>
          </p>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Solana Transaction Hash *
            </label>
            <input
              type="text"
              value={confirmData.txHash}
              onChange={(e) => setConfirmData({ ...confirmData, txHash: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="5KtPn1LGuxhFiwjxErkxTb3sv..."
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Crypto Amount
              </label>
              <input
                type="number"
                step="0.001"
                value={confirmData.cryptoAmount}
                onChange={(e) => setConfirmData({ ...confirmData, cryptoAmount: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="25.5"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Currency
              </label>
              <select
                value={confirmData.cryptoCurrency}
                onChange={(e) => setConfirmData({ ...confirmData, cryptoCurrency: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setConfirmModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={confirming}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {confirming ? 'Confirming...' : 'Confirm Payment'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Link Node Modal */}
      <Modal
        isOpen={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        title="Link Node to Investment"
      >
        <form onSubmit={handleLinkNode} className="space-y-4">
          <p className="text-text-muted">
            Link a provisioned node to this investment for{' '}
            <span className="text-text-primary font-medium">{selectedInvestment?.nodeRunnerName}</span>
          </p>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Node ID *
            </label>
            <input
              type="text"
              value={nodeId}
              onChange={(e) => setNodeId(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="clxyz123..."
              required
            />
            <p className="text-xs text-text-muted mt-1">
              Enter the ID of the node you just provisioned
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setLinkModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={linking}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {linking ? 'Linking...' : 'Link Node'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Create Investment Modal */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Add Investment"
      >
        <form onSubmit={handleCreateInvestment} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Node Runner *
            </label>
            <select
              value={newInvestment.nodeRunnerId}
              onChange={(e) => setNewInvestment({ ...newInvestment, nodeRunnerId: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              required
            >
              <option value="">Select a node runner...</option>
              {nodeRunners.map((nr) => (
                <option key={nr.id} value={nr.id}>
                  {nr.name} ({nr.walletAddress.slice(0, 8)}...)
                </option>
              ))}
            </select>
            {nodeRunners.length === 0 && (
              <p className="text-xs text-warning mt-1">
                No node runners found. <Link href="/node-runners" className="text-accent hover:underline">Create one first</Link>.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Amount (USD) *
            </label>
            <input
              type="number"
              step="0.01"
              value={newInvestment.amount}
              onChange={(e) => setNewInvestment({ ...newInvestment, amount: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="2500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              GPU Tier *
            </label>
            <select
              value={newInvestment.gpuTier}
              onChange={(e) => setNewInvestment({ ...newInvestment, gpuTier: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="H100">H100</option>
              <option value="H200">H200</option>
              <option value="B200">B200</option>
              <option value="B300">B300</option>
              <option value="GB300">GB300</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Transaction Hash (optional)
            </label>
            <input
              type="text"
              value={newInvestment.txHash}
              onChange={(e) => setNewInvestment({ ...newInvestment, txHash: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="Leave empty for pending payment"
            />
            <p className="text-xs text-text-muted mt-1">
              If provided, investment will be marked as PAID immediately
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setCreateModalOpen(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creatingInvestment || !newInvestment.nodeRunnerId}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {creatingInvestment ? 'Creating...' : 'Create Investment'}
            </button>
          </div>
        </form>
      </Modal>
    </motion.div>
  )
}

function _ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
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

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}
