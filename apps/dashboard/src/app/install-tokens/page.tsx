'use client'

/*
 * Admin install-token management. Lists every BYOG install token the
 * portal has minted plus its lifecycle state, and exposes a Revoke
 * button for the typo case (wrong operator, leaked URL, expired
 * ad-hoc support session). Revoke is a soft kill — the row stays
 * for audit, expiresAt is moved to the past so the install endpoint
 * starts refusing it on next hit.
 *
 * Consumed tokens are listed for visibility but cannot be revoked
 * (the node is already alive — admin should pause/delete the Node
 * row from /nodes instead).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { KeyRound, RotateCcw, AlertTriangle } from 'lucide-react'
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

interface InstallToken {
  id: string
  token: string
  region: string | null
  createdAt: string
  expiresAt: string
  consumedAt: string | null
  consumedByNodeId: string | null
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED'
  nodeRunner: { id: string; name: string; email: string | null } | null
}

interface Counts {
  active: number
  consumed: number
  expired: number
  total: number
}

const STATUS_STYLES: Record<InstallToken['status'], { bg: string; color: string }> = {
  ACTIVE: { bg: 'rgba(34,197,94,0.1)', color: '#22c55e' },
  CONSUMED: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6' },
  EXPIRED: { bg: 'rgba(115,115,115,0.1)', color: '#737373' },
}

export default function InstallTokensPage() {
  const [tokens, setTokens] = useState<InstallToken[]>([])
  const [counts, setCounts] = useState<Counts>({ active: 0, consumed: 0, expired: 0, total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [revokeTarget, setRevokeTarget] = useState<InstallToken | null>(null)
  const [revoking, setRevoking] = useState(false)

  async function load() {
    try {
      setLoading(true)
      const data = await api.installTokens.list()
      setTokens(data.tokens)
      setCounts(data.counts)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load install tokens')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleRevoke() {
    if (!revokeTarget) return
    try {
      setRevoking(true)
      await api.installTokens.revoke(revokeTarget.id)
      setRevokeTarget(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke install token')
    } finally {
      setRevoking(false)
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
      <motion.div variants={item}>
        <div className="dash-header">
          <div className="dash-header-left">
            <h1><KeyRound size={28} /> Install Tokens</h1>
            <p style={{ color: 'var(--text-muted)' }} className="mt-1 text-sm">
              One-shot BYOG install tokens minted from the operator portal. Soft-revoke a token to stop the curl one-liner from running.
            </p>
          </div>
          <div className="dash-header-right">
            <button
              onClick={load}
              className="px-3 py-1.5 text-sm rounded-md hover:opacity-80 transition-opacity flex items-center gap-2"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}
            >
              <RotateCcw size={14} />
              Refresh
            </button>
          </div>
        </div>
      </motion.div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <motion.div variants={item} className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <CountTile label="Active" value={counts.active} accent="#22c55e" />
        <CountTile label="Consumed" value={counts.consumed} accent="#3b82f6" />
        <CountTile label="Expired" value={counts.expired} accent="#737373" />
        <CountTile label="Total" value={counts.total} accent="var(--text-primary)" />
      </motion.div>

      <motion.div
        variants={item}
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border-color)' }}>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">Operator</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">Token (truncated)</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">Region</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">Created</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">Expires</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-text-muted uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tokens.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-text-muted">
                    No install tokens have been minted yet.
                  </td>
                </tr>
              ) : (
                tokens.map((t) => {
                  const ss = STATUS_STYLES[t.status]
                  return (
                    <tr key={t.id} className="hover:bg-surface-hover transition-colors">
                      <td className="px-6 py-4">
                        {t.nodeRunner ? (
                          <Link href={`/node-runners/${t.nodeRunner.id}`} className="hover:underline">
                            <p className="font-medium text-text-primary">{t.nodeRunner.name}</p>
                            {t.nodeRunner.email && (
                              <p className="text-xs text-text-muted">{t.nodeRunner.email}</p>
                            )}
                          </Link>
                        ) : (
                          <span className="text-text-muted">(deleted)</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <code className="text-xs font-mono text-text-secondary bg-background px-2 py-1 rounded">
                          {t.token.slice(0, 8)}...{t.token.slice(-4)}
                        </code>
                      </td>
                      <td className="px-6 py-4 text-text-secondary text-sm">
                        {t.region ?? <span className="text-text-muted">any</span>}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                          style={{ background: ss.bg, color: ss.color }}
                        >
                          {t.status}
                        </span>
                        {t.status === 'CONSUMED' && t.consumedByNodeId && (
                          <Link
                            href={`/nodes/${t.consumedByNodeId}`}
                            className="block text-xs text-accent hover:underline mt-1 font-mono"
                          >
                            → node {t.consumedByNodeId.slice(0, 8)}
                          </Link>
                        )}
                      </td>
                      <td className="px-6 py-4 text-text-muted text-sm">
                        {new Date(t.createdAt).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-text-muted text-sm">
                        {new Date(t.expiresAt).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {t.status === 'ACTIVE' ? (
                          <button
                            onClick={() => setRevokeTarget(t)}
                            className="text-error/80 hover:text-error text-sm font-medium"
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </motion.div>

      <Modal
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="Revoke install token"
      >
        {revokeTarget && (
          <div className="space-y-4">
            <div
              className="flex items-start gap-3 p-3 rounded-md"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)' }}
            >
              <AlertTriangle size={18} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 2 }} />
              <div>
                <p className="text-sm text-text-primary font-medium mb-1">
                  This will kill the install URL immediately.
                </p>
                <p className="text-xs text-text-muted leading-relaxed">
                  The curl one-liner that uses this token will start returning &ldquo;mint a fresh one&rdquo; on its next attempt. The row stays in the DB for audit but can never claim a node.
                </p>
              </div>
            </div>

            <div className="text-sm space-y-2" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex justify-between">
                <span className="text-text-muted">Operator</span>
                <span className="text-text-primary">{revokeTarget.nodeRunner?.name ?? '(deleted)'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Token</span>
                <code className="text-xs font-mono">{revokeTarget.token.slice(0, 16)}...</code>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Created</span>
                <span>{new Date(revokeTarget.createdAt).toLocaleString()}</span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setRevokeTarget(null)}
                className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
                disabled={revoking}
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="px-4 py-2 bg-error hover:bg-error/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
              >
                {revoking ? 'Revoking...' : 'Revoke token'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </motion.div>
  )
}

function CountTile({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
    >
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-2xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </p>
    </div>
  )
}
