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
 *     COMPLETED rentals, wired in /buyer/requests/[id])
 *
 * If the rental isn't COMPLETED, the API returns 400 and we show an
 * error state. If a rating already exists, we show the previous rating
 * and let the buyer overwrite (which re-enters PENDING moderation).
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Star, ArrowLeft, MessageSquare } from 'lucide-react'
import { buyer } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

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
      /* silent, page handles fresh-rate case */
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
      toast('success', existingRating ? 'Rating updated, pending re-moderation' : 'Rating submitted, pending moderation')
      router.push(`/buyer/requests/${id}`)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit rating')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <DashboardShell title="Rate this rental" subtitle="Loading...">
        <div className="lg:col-span-3 max-w-3xl mx-auto w-full">
          <FormCard title="Loading" icon={Star}>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading rating...</p>
          </FormCard>
        </div>
      </DashboardShell>
    )
  }

  return (
    <DashboardShell
      title="Rate this rental"
      subtitle="Help other buyers pick reliable operators"
    >
      <div className="lg:col-span-3 max-w-3xl mx-auto w-full space-y-6">
        <button
          type="button"
          onClick={() => router.push(`/buyer/requests/${id}`)}
          className="inline-flex items-center gap-2 text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft size={14} /> Back to rental
        </button>

        {existingRating && (
          <div
            className="rounded-lg p-4"
            style={{
              background: 'rgba(59,130,246,0.08)',
              border: '1px solid rgba(59,130,246,0.3)',
            }}
          >
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
              You already rated this rental {existingRating.score} star{existingRating.score === 1 ? '' : 's'}
              {' '}<span style={{ color: 'var(--text-muted)' }}>(status: {existingRating.moderationStatus})</span>
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Submitting a new rating will overwrite the existing one and reset moderation status.
            </p>
          </div>
        )}

        <FormCard
          title="Your Rating"
          description="Ratings are reviewed by the team before publishing."
          icon={Star}
          footer={
            <>
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
            </>
          }
        >
          <FormSection title="Score">
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
          </FormSection>

          <FormSection title="Comment" description="Optional, max 500 characters">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <MessageSquare size={14} style={{ color: 'var(--text-muted)' }} />
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  What worked well? What could be better? Specifics help operators improve.
                </span>
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                rows={5}
                placeholder="Be specific, operator-side improvements depend on signal."
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
            </div>
          </FormSection>
        </FormCard>
      </div>
    </DashboardShell>
  )
}
