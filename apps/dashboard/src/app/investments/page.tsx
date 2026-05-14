'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  CircleCheck, Plus,
  Clock as ClockLucide, Server as ServerLucide, AlertTriangle,
  DollarSign,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import {
  DashboardShell,
  MetricTriad,
  DataTableCard,
  type DataTableColumn,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

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

type InvestmentRow = Investment & Record<string, unknown>

type FilterValue = 'all' | 'PENDING' | 'PAID' | 'PROVISIONED'

const STATUS_FILTERS: { label: string; value: FilterValue }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'PENDING' },
  { label: 'Paid', value: 'PAID' },
  { label: 'Provisioned', value: 'PROVISIONED' },
]

export default function InvestmentsPage() {
  const [investments, setInvestments] = useState<Investment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterValue>('all')

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
    } catch {
      // Silently fail. Node runners are optional for this page.
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
  const totalInvested = investments.reduce((sum, i) => sum + i.amount, 0)

  const metrics: MetricCardData[] = [
    { label: 'Pending Payment', value: pendingPayments.length, icon: ClockLucide, tone: 'orange' },
    { label: 'Awaiting Provisioning', value: pendingProvisioning.length, icon: ServerLucide, tone: 'purple' },
    { label: 'Provisioned', value: provisioned.length, icon: CircleCheck, tone: 'green' },
  ]

  const columns: Array<DataTableColumn<InvestmentRow>> = [
    {
      key: 'nodeRunnerName',
      header: 'Node Runner',
      render: (inv) => (
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{inv.nodeRunnerName}</p>
          <code className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {inv.walletAddress.slice(0, 8)}...{inv.walletAddress.slice(-6)}
          </code>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (inv) => (
        <div>
          <span style={{ color: 'var(--text-primary)' }}>${inv.amount.toLocaleString()}</span>
          {inv.cryptoAmount && (
            <span className="text-xs block" style={{ color: 'var(--text-muted)' }}>
              {inv.cryptoAmount} {inv.cryptoCurrency}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'gpuTier',
      header: 'GPU',
      render: (inv) => (
        <span className="px-2 py-0.5 bg-accent/10 text-accent rounded text-xs font-medium">
          {inv.gpuTier}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (inv) => (
        <span
          className="px-2 py-0.5 rounded-full text-xs font-medium"
          style={
            inv.status === 'PROVISIONED'
              ? { background: 'rgba(34,197,94,0.1)', color: 'var(--success)' }
              : inv.status === 'PAID'
                ? { background: 'rgba(139,92,246,0.1)', color: '#a78bfa' }
                : inv.status === 'PENDING'
                  ? { background: 'rgba(245,158,11,0.1)', color: 'var(--warning)' }
                  : { background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }
          }
        >
          {inv.status}
        </span>
      ),
    },
    {
      key: 'txHash',
      header: 'TX Hash',
      mono: true,
      render: (inv) =>
        inv.txHash ? (
          <a
            href={`https://solscan.io/tx/${inv.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs hover:underline"
            style={{ color: 'var(--primary)' }}
          >
            {inv.txHash.slice(0, 8)}...
          </a>
        ) : (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Date',
      mono: true,
      render: (inv) => (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {new Date(inv.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (inv) => (
        <div className="flex items-center justify-end gap-2">
          {inv.status === 'PENDING' && (
            <>
              <button
                onClick={() => {
                  setSelectedInvestment(inv)
                  setConfirmModalOpen(true)
                }}
                className="px-3 py-1 text-xs bg-warning/10 text-warning hover:bg-warning/20 rounded-md transition-colors"
              >
                Confirm
              </button>
              <button
                onClick={() => handleCancelInvestment(inv.id)}
                disabled={cancelling === inv.id}
                className="px-3 py-1 text-xs text-error/70 hover:text-error transition-colors disabled:opacity-50"
              >
                {cancelling === inv.id ? '...' : 'Cancel'}
              </button>
            </>
          )}
          {inv.status === 'PAID' && (
            <Link
              href={`/nodes?provision=true&investmentId=${inv.id}`}
              className="px-3 py-1 text-xs bg-accent text-white hover:bg-accent-hover rounded-md transition-colors"
            >
              Provision Node
            </Link>
          )}
          {inv.status === 'PROVISIONED' && inv.nodeId && (
            <Link
              href={`/nodes/${inv.nodeId}`}
              className="text-xs hover:underline"
              style={{ color: 'var(--primary)' }}
            >
              View Node
            </Link>
          )}
        </div>
      ),
    },
  ]

  const headerActions = (
    <button
      onClick={() => setCreateModalOpen(true)}
      className="px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5"
      style={{ background: 'var(--primary)', color: '#fff' }}
    >
      <Plus size={14} />
      Add Investment
    </button>
  )

  const statusPills = (
    <div className="flex items-center gap-2 flex-wrap">
      {STATUS_FILTERS.map(sf => {
        const isActive = filter === sf.value
        return (
          <button
            key={sf.value}
            onClick={() => setFilter(sf.value)}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
            style={isActive
              ? { background: 'var(--primary)', color: '#fff' }
              : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
            }
          >
            {sf.label}
          </button>
        )
      })}
      {headerActions}
    </div>
  )

  return (
    <DashboardShell
      title="Investments"
      subtitle={`$${totalInvested.toLocaleString()} total invested`}
      onRefresh={loadInvestments}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
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

        <MetricTriad metrics={metrics} />

        {/* Total Invested + Pending Provisioning Alert */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            className="rounded-md border p-4"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-color)' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-md flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <DollarSign size={20} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Total Invested</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  ${totalInvested.toLocaleString()}
                </p>
              </div>
            </div>
          </div>

          {pendingProvisioning.length > 0 && (
            <div
              className="rounded-md p-4"
              style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)' }}
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.2)' }}>
                  <AlertTriangle size={16} style={{ color: '#a78bfa' }} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {pendingProvisioning.length} investment{pendingProvisioning.length !== 1 ? 's' : ''} awaiting provisioning
                  </h3>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Node runners paid and are waiting for setup. Contact the data center for SSH credentials.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <DataTableCard<InvestmentRow>
          title={filter === 'all' ? 'All Investments' : `${filter} Investments`}
          icon={DollarSign}
          actions={statusPills}
          columns={columns}
          rows={investments as InvestmentRow[]}
          loading={loading && investments.length === 0}
          empty={
            <p className="text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No investments found
            </p>
          }
        />
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
    </DashboardShell>
  )
}
