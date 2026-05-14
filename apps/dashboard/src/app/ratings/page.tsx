'use client'

/**
 * M3 admin moderation queue for buyer ratings.
 *
 * Default view: PENDING ratings awaiting approve/reject. Filter pills
 * also expose APPROVED + REJECTED for audit. Each row shows the rental
 * context (GPU, tier, cost) so the moderator can spot obvious mismatches
 * (e.g. 1-star comment about preemption on a SPOT rental, that's
 * working as designed, not the operator's fault).
 */

import { useState, useEffect, useCallback } from 'react'
import { Star, Check, X, Loader2, MessageSquare } from 'lucide-react'
import { api } from '@/lib/api'
import {
  DashboardShell,
  DataTableCard,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

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

type RatingRow = Rating & Record<string, unknown>

const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'Pending', value: 'PENDING' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'All', value: 'all' },
]

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

  const columns: Array<DataTableColumn<RatingRow>> = [
    {
      key: 'score',
      header: 'Rating',
      render: (r) => (
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map(n => (
            <Star
              key={n}
              size={14}
              fill={n <= r.score ? '#facc15' : 'transparent'}
              style={{ color: n <= r.score ? '#facc15' : 'var(--text-muted)' }}
            />
          ))}
        </div>
      ),
    },
    {
      key: 'comment',
      header: 'Comment / Context',
      render: (r) => (
        <div className="max-w-md space-y-1">
          {r.comment && (
            <p className="text-sm italic" style={{ color: 'var(--text-primary)' }}>
              &ldquo;{r.comment}&rdquo;
            </p>
          )}
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {r.computeRequest.gpuCount}x {r.computeRequest.gpuTier} ({r.computeRequest.tier}) — ${r.computeRequest.totalCost.toFixed(2)}
          </p>
          {r.moderationNote && (
            <p
              className="text-xs px-2 py-1 rounded mt-1 inline-block"
              style={{ background: 'rgba(239,68,68,0.08)', color: 'var(--text-secondary)', border: '1px solid rgba(239,68,68,0.2)' }}
            >
              Reject note: {r.moderationNote}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'nodeRunner',
      header: 'Operator',
      render: (r) => (
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {r.nodeRunner.name}
        </span>
      ),
    },
    {
      key: 'buyer',
      header: 'Buyer',
      mono: true,
      render: (r) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {r.buyer?.email ?? (r.buyer?.walletAddress ? `${r.buyer.walletAddress.slice(0, 10)}...` : 'unknown')}
        </span>
      ),
    },
    {
      key: 'moderationStatus',
      header: 'Status',
      render: (r) => {
        const color =
          r.moderationStatus === 'APPROVED'
            ? { bg: 'rgba(34,197,94,0.1)', text: 'var(--success)' }
            : r.moderationStatus === 'REJECTED'
              ? { bg: 'rgba(239,68,68,0.1)', text: 'var(--danger)' }
              : { bg: 'rgba(245,158,11,0.1)', text: 'var(--warning)' }
        return (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ background: color.bg, color: color.text }}
          >
            {r.moderationStatus}
          </span>
        )
      },
    },
    {
      key: 'createdAt',
      header: 'Submitted',
      mono: true,
      render: (r) => new Date(r.createdAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: 'Actions',
      align: 'right',
      render: (r) => {
        if (r.moderationStatus !== 'PENDING') {
          return <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
        }
        const isExpanded = rejectingId === r.id
        return (
          <div className="flex items-center justify-end gap-2">
            {isExpanded ? (
              <>
                <input
                  type="text"
                  placeholder="Optional reject note"
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  maxLength={500}
                  className="px-2 py-1 text-xs rounded-md w-40"
                  style={{
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                  }}
                />
                <button
                  onClick={() => handleReject(r.id)}
                  disabled={actionId === r.id}
                  className="px-2.5 py-1 text-xs bg-error/10 text-error hover:bg-error/20 rounded-md disabled:opacity-50"
                >
                  {actionId === r.id ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                </button>
                <button
                  onClick={() => { setRejectingId(null); setRejectNote('') }}
                  className="px-2 py-1 text-xs"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => handleApprove(r.id)}
                  disabled={actionId === r.id}
                  className="px-2.5 py-1 text-xs bg-success/10 text-success hover:bg-success/20 rounded-md flex items-center gap-1 disabled:opacity-50"
                >
                  {actionId === r.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Approve
                </button>
                <button
                  onClick={() => { setRejectingId(r.id); setRejectNote('') }}
                  className="px-2.5 py-1 text-xs bg-error/10 text-error hover:bg-error/20 rounded-md flex items-center gap-1"
                >
                  <X size={12} />
                  Reject
                </button>
              </>
            )}
          </div>
        )
      },
    },
  ]

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
            <span className="ml-1.5" style={{ color: isActive ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
              {getCount(sf.value)}
            </span>
          </button>
        )
      })}
    </div>
  )

  return (
    <DashboardShell
      title="Ratings Moderation"
      subtitle={counts.pending > 0 ? `${counts.pending} awaiting review` : `${ratings.length} ratings`}
      onRefresh={loadData}
      refreshing={loading}
    >
      <div className="lg:col-span-3">
        <DataTableCard<RatingRow>
          title="Buyer Ratings"
          icon={MessageSquare}
          actions={statusPills}
          columns={columns}
          rows={ratings as RatingRow[]}
          loading={loading && ratings.length === 0}
          empty={
            <p className="text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No ratings in <strong>{filter}</strong> state.
            </p>
          }
        />
      </div>
    </DashboardShell>
  )
}
