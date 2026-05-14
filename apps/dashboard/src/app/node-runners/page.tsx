'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Users, Plus, Edit, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface NodeRunner {
  id: string
  name: string
  email: string | null
  walletAddress: string
  nodeCount: number
  totalInvested: number
  createdAt: string
}

type NodeRunnerRow = NodeRunner & Record<string, unknown>

export default function NodeRunnersPage() {
  const [nodeRunners, setNodeRunners] = useState<NodeRunner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newRunner, setNewRunner] = useState({ name: '', email: '', walletAddress: '' })

  // Edit modal state
  const [showEditModal, setShowEditModal] = useState(false)
  const [editRunner, setEditRunner] = useState<NodeRunner | null>(null)
  const [editData, setEditData] = useState({ name: '', email: '', walletAddress: '' })
  const [updating, setUpdating] = useState(false)

  // Delete confirmation state
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteRunner, setDeleteRunner] = useState<NodeRunner | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    loadNodeRunners()
  }, [])

  async function loadNodeRunners() {
    try {
      setLoading(true)
      const data = await api.nodeRunners.list()
      setNodeRunners(data.nodeRunners)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load node runners')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    try {
      setCreating(true)
      await api.nodeRunners.create({
        name: newRunner.name,
        email: newRunner.email || undefined,
        walletAddress: newRunner.walletAddress,
      })
      setShowCreateModal(false)
      setNewRunner({ name: '', email: '', walletAddress: '' })
      await loadNodeRunners()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create node runner')
    } finally {
      setCreating(false)
    }
  }

  function openEditModal(runner: NodeRunner) {
    setEditRunner(runner)
    setEditData({
      name: runner.name,
      email: runner.email || '',
      walletAddress: runner.walletAddress,
    })
    setShowEditModal(true)
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!editRunner) return

    try {
      setUpdating(true)
      await api.nodeRunners.update(editRunner.id, {
        name: editData.name,
        email: editData.email || undefined,
        walletAddress: editData.walletAddress,
      })
      setShowEditModal(false)
      setEditRunner(null)
      await loadNodeRunners()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update node runner')
    } finally {
      setUpdating(false)
    }
  }

  async function handleDelete() {
    if (!deleteRunner) return

    try {
      setDeleting(true)
      await api.nodeRunners.delete(deleteRunner.id)
      setShowDeleteModal(false)
      setDeleteRunner(null)
      await loadNodeRunners()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete node runner')
    } finally {
      setDeleting(false)
    }
  }

  const columns: Array<DataTableColumn<NodeRunnerRow>> = [
    {
      key: 'name',
      header: 'Node Runner',
      render: (r) => (
        <div>
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{r.name}</p>
          {r.email && (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{r.email}</p>
          )}
        </div>
      ),
    },
    {
      key: 'walletAddress',
      header: 'Wallet',
      mono: true,
      render: (r) => `${r.walletAddress.slice(0, 8)}...${r.walletAddress.slice(-6)}`,
    },
    {
      key: 'nodeCount',
      header: 'Nodes',
      render: (r) => (
        <span
          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
          style={{
            background: r.nodeCount > 0 ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)',
            color: r.nodeCount > 0 ? 'var(--success)' : 'var(--warning)',
          }}
        >
          {r.nodeCount} {r.nodeCount === 1 ? 'node' : 'nodes'}
        </span>
      ),
    },
    {
      key: 'totalInvested',
      header: 'Total Invested',
      align: 'right',
      mono: true,
      render: (r) => `$${r.totalInvested.toLocaleString()}`,
    },
    {
      key: 'createdAt',
      header: 'Joined',
      align: 'right',
      mono: true,
      render: (r) => new Date(r.createdAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/node-runners/${r.id}`}
            className="text-sm font-medium hover:underline"
            style={{ color: 'var(--primary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            View
          </Link>
          <button
            onClick={(e) => { e.stopPropagation(); openEditModal(r) }}
            className="text-sm flex items-center gap-1"
            style={{ color: 'var(--text-muted)' }}
          >
            <Edit size={14} />
            Edit
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setDeleteRunner(r)
              setShowDeleteModal(true)
            }}
            className="text-sm flex items-center gap-1"
            style={{ color: 'var(--danger)' }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      ),
    },
  ]

  return (
    <DashboardShell
      title="Node Runners"
      subtitle="Manage GPU node investors and their investments"
      onRefresh={loadNodeRunners}
      refreshing={loading}
    >
      <div className="lg:col-span-3 space-y-6">
        {error && (
          <div
            className="px-4 py-3 rounded-md text-sm"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: 'var(--danger)' }}
          >
            {error}
          </div>
        )}

        <DataTableCard<NodeRunnerRow>
          title="Node Runners"
          icon={Users}
          actions={
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3 py-1.5 text-sm rounded-md font-medium transition-colors flex items-center gap-1"
              style={{ background: 'var(--primary)', color: '#fff' }}
            >
              <Plus size={14} />
              Add Node Runner
            </button>
          }
          columns={columns}
          rows={nodeRunners as NodeRunnerRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Users}
              title="No node runners yet"
              description={'Click "Add Node Runner" to get started.'}
            />
          }
        />
      </div>

      {/* Create Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Add Node Runner"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Name *
            </label>
            <input
              type="text"
              value={newRunner.name}
              onChange={(e) => setNewRunner({ ...newRunner, name: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="John Doe"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Email
            </label>
            <input
              type="email"
              value={newRunner.email}
              onChange={(e) => setNewRunner({ ...newRunner, email: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="john@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Solana Wallet Address *
            </label>
            <input
              type="text"
              value={newRunner.walletAddress}
              onChange={(e) => setNewRunner({ ...newRunner, walletAddress: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"
              placeholder="7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
              required
            />
            <p className="text-xs text-text-muted mt-1">
              This wallet will receive all earnings payouts
            </p>
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Node Runner'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        title="Edit Node Runner"
      >
        <form onSubmit={handleUpdate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Name *
            </label>
            <input
              type="text"
              value={editData.name}
              onChange={(e) => setEditData({ ...editData, name: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Email
            </label>
            <input
              type="email"
              value={editData.email}
              onChange={(e) => setEditData({ ...editData, email: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Solana Wallet Address *
            </label>
            <input
              type="text"
              value={editData.walletAddress}
              onChange={(e) => setEditData({ ...editData, walletAddress: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={() => setShowEditModal(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={updating}
              className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {updating ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="Delete Node Runner"
      >
        <div className="space-y-4">
          <p className="text-text-secondary">
            Are you sure you want to delete{' '}
            <span className="text-text-primary font-medium">{deleteRunner?.name}</span>?
          </p>
          <p className="text-sm text-text-muted">
            This action cannot be undone. The node runner must have no active nodes or investments.
          </p>
          <div className="flex justify-end gap-3 pt-4">
            <button
              onClick={() => setShowDeleteModal(false)}
              className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 bg-error hover:bg-error/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </div>
      </Modal>
    </DashboardShell>
  )
}
