'use client'

/**
 * M3 buyer rating page. Lets the buyer rate the operator after a
 * COMPLETED rental. One rating per rental (server-side enforced via
 * unique constraint on Rating.computeRequestId). Re-rating is allowed
 * but resets to PENDING moderation status.
 *
 * Reachable from:
 *   - The bell-icon notification "Rental Ended" (via direct link)
 *   - The buyer's request detail page (a "Rate this rental" CTA on
 *     COMPLETED rentals — wired in /buyer/requests/[id])
 *
 * If the rental isn't COMPLETED, the API returns 400 and we show an
 * error state. If a rating already exists, we show the previous rating
 * and let the buyer overwrite (which re-enters PENDING moderation).
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Star, ArrowLeft } from 'lucide-react'
import { buyer } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function RateRentalPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const id = params.id as string

  const [score, setScore] = useState(0)
  const [hoverScore, setHoverScore] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [existingRating, setExistingRating] = useState<{ score: number; comment: string | null; moderationStatus: string } | null>(null)
  const [loading, setLoading] = useState(true)

  const loadExisting = useCallback(async () => {
    try {
      const result = await buyer.getRating(id)
      if (result.rating) {
        setExistingRating({
          score: result.rating.score,
          comment: result.rating.comment,
          moderationStatus: result.rating.moderationStatus,
        })
        setScore(result.rating.score)
        setComment(result.rating.comment ?? '')
      }
    } catch {
      /* silent — page handles fresh-rate case */
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadExisting()
  }, [loadExisting])

  const handleSubmit = async () => {
    if (score < 1 || score > 5) {
      toast('error', 'Pick a star rating from 1 to 5')
      return
    }
    if (comment.length > 500) {
      toast('error', 'Comment must be 500 characters or fewer')
      return
    }
    setSubmitting(true)
    try {
      await buyer.rate(id, { score, comment: comment.trim() || undefined })
      toast('success', existingRating ? 'Rating updated — pending re-moderation' : 'Rating submitted — pending moderation')
      router.push(`/buyer/requests/${id}`)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit rating')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="text-center py-20" style={{ color: 'var(--text-muted)' }}>Loading...</div>
  }

  return (
    <motion.div
      className="space-y-6 max-w-2xl mx-auto"
      variants={container}
      initial="hidden"
      animate="show"
    >
      <motion.button
        variants={item}
        type="button"
        onClick={() => router.push(`/buyer/requests/${id}`)}
        className="inline-flex items-center gap-2 text-sm"
        style={{ color: 'var(--text-muted)' }}
      >
        <ArrowLeft size={14} /> Back to rental
      </motion.button>

      <motion.div variants={item}>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Rate this rental
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Your feedback helps other buyers pick reliable operators. Ratings are reviewed by the team before publishing.
        </p>
      </motion.div>

      {existingRating && (
        <motion.div
          variants={item}
          className="rounded-xl p-4"
          style={{
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.3)',
          }}
        >
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            You already rated this rental {existingRating.score} star{existingRating.score === 1 ? '' : 's'}
            {' — '}<span style={{ color: 'var(--text-muted)' }}>status: {existingRating.moderationStatus}</span>
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Submitting a new rating will overwrite the existing one and reset moderation status.
          </p>
        </motion.div>
      )}

      {/* Star picker */}
      <motion.div variants={item} className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Score</h2>
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4, 5].map(n => {
            const filled = n <= (hoverScore || score)
            return (
              <button
                key={n}
                type="button"
                onClick={() => setScore(n)}
                onMouseEnter={() => setHoverScore(n)}
                onMouseLeave={() => setHoverScore(0)}
                className="transition-transform hover:scale-110"
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
              >
                <Star
                  size={36}
                  fill={filled ? '#facc15' : 'transparent'}
                  style={{ color: filled ? '#facc15' : 'var(--text-muted)' }}
                />
              </button>
            )
          })}
          {score > 0 && (
            <span className="ml-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {score} star{score === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </motion.div>

      {/* Comment */}
      <motion.div variants={item} className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
          Comment <span style={{ color: 'var(--text-muted)' }}>(optional, ≤500 chars)</span>
        </h2>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={500}
          rows={5}
          placeholder="What worked well? What could be better? Be specific — operator-side improvements depend on signal."
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
          }}
        />
        <p className="text-xs mt-1 text-right" style={{ color: 'var(--text-muted)' }}>
          {comment.length} / 500
        </p>
      </motion.div>

      <motion.div variants={item} className="flex gap-3 justify-end">
        <Button
          variant="secondary"
          size="md"
          onClick={() => router.push(`/buyer/requests/${id}`)}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleSubmit}
          disabled={submitting || score < 1}
        >
          {submitting ? 'Submitting...' : existingRating ? 'Update Rating' : 'Submit Rating'}
        </Button>
      </motion.div>
    </motion.div>
  )
}
