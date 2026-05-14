'use client'

/**
 * M3 admin moderation queue for buyer ratings.
 *
 * Default view: PENDING ratings awaiting approve/reject. Filter pills
 * also expose APPROVED + REJECTED for audit. Each row shows the rental
 * context (GPU, tier, cost) so the moderator can spot obvious mismatches
 * (e.g. 1-star comment about preemption on a SPOT rental — that's
 * working as designed, not the operator's fault).
 */

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Star, Check, X, Loader2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

type StatusFilter = 'PENDING' | 'APPROVED' | 'REJECTED' | 'all'

interface Rating {
  id: string
  score: number
  comment: string | null
  moderationStatus: 'PENDING' | 'APPROVED' | 'REJECTED'
  moderationNote: string | null
  createdAt: string
  buyer: { id: string; email: string | null; walletAddress: string | null } | null
  nodeRunner: { id: string; name: string; slug: string | null }
  computeRequest: {
    id: string
    gpuTier: string
    gpuCount: number
    durationDays: number
    totalCost: number
    tier: string
    completedAt: string | null
  }
}

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'Pending', value: 'PENDING' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'All', value: 'all' },
]

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.05 } } }
const item = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

export default function RatingsModerationPage() {
  const [ratings, setRatings] = useState<Rating[]>([])
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [filter, setFilter] = useState<StatusFilter>('PENDING')
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.ratings.list(filter)
      setRatings(data.ratings)
      setCounts(data.counts)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load ratings:', err)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleApprove = async (id: string) => {
    setActionId(id)
    try {
      await api.ratings.approve(id)
      await loadData()
    } finally {
      setActionId(null)
    }
  }

  const handleReject = async (id: string) => {
    setActionId(id)
    try {
      await api.ratings.reject(id, rejectNote.trim() || undefined)
      setRejectingId(null)
      setRejectNote('')
      await loadData()
    } finally {
      setActionId(null)
    }
  }

  const getCount = (v: StatusFilter) => {
    if (v === 'PENDING') return counts.pending
    if (v === 'APPROVED') return counts.approved
    if (v === 'REJECTED') return counts.rejected
    return counts.pending + counts.approved + counts.rejected
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      <motion.div variants={item} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Ratings Moderation</h1>
          <p className="text-sm mt-1 text-text-muted">
            Review buyer-submitted ratings before they affect operator reputation scores or appear on public profiles.
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-surface border border-border text-text-secondary hover:text-text-primary rounded-lg flex items-center gap-2"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </motion.div>

      {/* Filter pills */}
      <motion.div variants={item} className="flex items-center gap-2 flex-wrap">
        {STATUS_FILTERS.map(sf => (
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
              {getCount(sf.value)}
            </span>
          </button>
        ))}
      </motion.div>

      {/* Ratings list */}
      <motion.div variants={item} className="space-y-3">
        {loading && ratings.length === 0 && (
          <div className="text-center py-12 text-text-muted">Loading...</div>
        )}
        {!loading && ratings.length === 0 && (
          <div className="text-center py-12 text-text-muted">
            No ratings in <strong>{filter}</strong> state.
          </div>
        )}
        {ratings.map(r => {
          const isExpanded = rejectingId === r.id
          const statusColor =
            r.moderationStatus === 'APPROVED'
              ? 'text-success'
              : r.moderationStatus === 'REJECTED'
                ? 'text-error'
                : 'text-warning'
          return (
            <div
              key={r.id}
              className="rounded-xl p-5"
              style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map(n => (
                      <Star
                        key={n}
                        size={18}
                        fill={n <= r.score ? '#facc15' : 'transparent'}
                        style={{ color: n <= r.score ? '#facc15' : 'var(--text-muted)' }}
                      />
                    ))}
                  </div>
                  <span className={`text-xs font-mono uppercase ${statusColor}`}>
                    {r.moderationStatus}
                  </span>
                </div>
                <span className="text-xs text-text-muted">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>

              {r.comment && (
                <p className="text-sm mb-3 text-text-primary italic">&ldquo;{r.comment}&rdquo;</p>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs mb-3">
                <div>
                  <span className="text-text-muted">Operator: </span>
                  <span className="text-text-primary font-medium">{r.nodeRunner.name}</span>
                </div>
                <div>
                  <span className="text-text-muted">Buyer: </span>
                  <span className="text-text-primary font-mono">
                    {r.buyer?.email ?? (r.buyer?.walletAddress ? `${r.buyer.walletAddress.slice(0, 10)}...` : 'unknown')}
                  </span>
                </div>
                <div>
                  <span className="text-text-muted">Rental: </span>
                  <span className="text-text-primary">
                    {r.computeRequest.gpuCount}× {r.computeRequest.gpuTier} ({r.computeRequest.tier})
                  </span>
                </div>
                <div>
                  <span className="text-text-muted">Cost: </span>
                  <span className="text-text-primary">${r.computeRequest.totalCost.toFixed(2)}</span>
                </div>
              </div>

              {r.moderationNote && (
                <div
                  className="mb-3 p-2 rounded-lg text-xs"
                  style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  <span className="text-text-muted">Reject note: </span>
                  <span className="text-text-secondary">{r.moderationNote}</span>
                </div>
              )}

              {r.moderationStatus === 'PENDING' && (
                <div className="flex gap-2 items-end">
                  {isExpanded ? (
                    <>
                      <input
                        type="text"
                        placeholder="Optional reject note (audit only)"
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        maxLength={500}
                        className="flex-1 px-3 py-2 text-xs rounded-lg"
                        style={{
                          background: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border-color)',
                        }}
                      />
                      <button
                        onClick={() => handleReject(r.id)}
                        disabled={actionId === r.id}
                        className="px-3 py-1.5 text-sm bg-error/10 text-error hover:bg-error/20 rounded-lg disabled:opacity-50"
                      >
                        {actionId === r.id ? <Loader2 size={14} className="animate-spin" /> : 'Confirm Reject'}
                      </button>
                      <button
                        onClick={() => { setRejectingId(null); setRejectNote('') }}
                        className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => handleApprove(r.id)}
                        disabled={actionId === r.id}
                        className="px-3 py-1.5 text-sm bg-success/10 text-success hover:bg-success/20 rounded-lg flex items-center gap-1 disabled:opacity-50"
                      >
                        {actionId === r.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Approve
                      </button>
                      <button
                        onClick={() => { setRejectingId(r.id); setRejectNote('') }}
                        className="px-3 py-1.5 text-sm bg-error/10 text-error hover:bg-error/20 rounded-lg flex items-center gap-1"
                      >
                        <X size={14} />
                        Reject
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </motion.div>
    </motion.div>
  )
}
