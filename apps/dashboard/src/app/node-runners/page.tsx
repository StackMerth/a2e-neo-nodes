'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Users, DollarSign, Server, Plus, Edit, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface NodeRunner {
  id: string
  name: string
  email: string | null
  walletAddress: string
  nodeCount: number
  totalInvested: number
  createdAt: string
}

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
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Node Runners</h1>
          <p style={{ color: 'var(--text-muted)' }} className="mt-1">Manage GPU node investors and their investments</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          <Plus size={20} />
          Add Node Runner
        </button>
      </motion.div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Stats Cards */}
      <motion.div variants={item} className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-xl p-4" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.1)' }}>
              <Users size={20} style={{ color: 'var(--info)' }} />
            </div>
            <div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Total Node Runners</p>
              <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{nodeRunners.length}</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl p-4" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.1)' }}>
              <DollarSign size={20} style={{ color: 'var(--success)' }} />
            </div>
            <div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Total Invested</p>
              <p className="text-2xl font-bold mt-1" style={{ color: 'var(--success)' }}>
                ${nodeRunners.reduce((sum, nr) => sum + nr.totalInvested, 0).toLocaleString()}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-xl p-4" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.1)' }}>
              <Server size={20} style={{ color: '#8b5cf6' }} />
            </div>
            <div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Active Nodes</p>
              <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                {nodeRunners.reduce((sum, nr) => sum + nr.nodeCount, 0)}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-xl p-4" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(245,158,11,0.1)' }}>
              <DollarSign size={20} style={{ color: 'var(--warning)' }} />
            </div>
            <div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Avg Investment</p>
              <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                ${nodeRunners.length > 0
                  ? Math.round(nodeRunners.reduce((sum, nr) => sum + nr.totalInvested, 0) / nodeRunners.length).toLocaleString()
                  : 0}
              </p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Node Runners Table */}
      <motion.div variants={item} className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <table className="w-full">
          <thead style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border-color)' }}>
            <tr>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                Node Runner
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                Wallet Address
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                Nodes
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                Total Invested
              </th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                Joined
              </th>
              <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {nodeRunners.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-text-muted">
                  No node runners yet. Click "Add Node Runner" to get started.
                </td>
              </tr>
            ) : (
              nodeRunners.map((runner) => (
                <tr key={runner.id} className="hover:bg-surface-hover transition-colors">
                  <td className="px-6 py-4">
                    <div>
                      <p className="font-medium text-text-primary">{runner.name}</p>
                      {runner.email && (
                        <p className="text-sm text-text-muted">{runner.email}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <code className="text-sm text-text-secondary bg-background px-2 py-1 rounded">
                      {runner.walletAddress.slice(0, 8)}...{runner.walletAddress.slice(-6)}
                    </code>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      runner.nodeCount > 0
                        ? 'bg-accent/10 text-accent'
                        : 'bg-warning/10 text-warning'
                    }`}>
                      {runner.nodeCount} {runner.nodeCount === 1 ? 'node' : 'nodes'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-text-primary font-medium">
                    ${runner.totalInvested.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-text-muted text-sm">
                    {new Date(runner.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/node-runners/${runner.id}`}
                        className="text-accent hover:text-accent-hover font-medium text-sm"
                      >
                        View
                      </Link>
                      <button
                        onClick={() => openEditModal(runner)}
                        className="text-text-muted hover:text-text-primary text-sm flex items-center gap-1"
                      >
                        <Edit size={14} />
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          setDeleteRunner(runner)
                          setShowDeleteModal(true)
                        }}
                        className="text-error/70 hover:text-error text-sm flex items-center gap-1"
                      >
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </motion.div>

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
    </motion.div>
  )
}

function _PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}
