'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { Modal } from '@/components/ui/Modal'

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Node Runners</h1>
          <p className="text-text-muted mt-1">Manage GPU node investors and their investments</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          <PlusIcon className="w-5 h-5" />
          Add Node Runner
        </button>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Total Node Runners</p>
          <p className="text-2xl font-bold text-text-primary mt-1">{nodeRunners.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Total Invested</p>
          <p className="text-2xl font-bold text-accent mt-1">
            ${nodeRunners.reduce((sum, nr) => sum + nr.totalInvested, 0).toLocaleString()}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Active Nodes</p>
          <p className="text-2xl font-bold text-text-primary mt-1">
            {nodeRunners.reduce((sum, nr) => sum + nr.nodeCount, 0)}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-text-muted text-sm">Avg Investment</p>
          <p className="text-2xl font-bold text-text-primary mt-1">
            ${nodeRunners.length > 0
              ? Math.round(nodeRunners.reduce((sum, nr) => sum + nr.totalInvested, 0) / nodeRunners.length).toLocaleString()
              : 0}
          </p>
        </div>
      </div>

      {/* Node Runners Table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-surface-hover">
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
                    <Link
                      href={`/node-runners/${runner.id}`}
                      className="text-accent hover:text-accent-hover font-medium text-sm"
                    >
                      View Details
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
    </div>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}
