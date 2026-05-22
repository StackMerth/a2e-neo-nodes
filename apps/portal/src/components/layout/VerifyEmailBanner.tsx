'use client'

/**
 * Soft-gate banner shown on every authenticated layout when the
 * signed-in user has emailVerified=false. Soft means: not modal, not
 * blocking — the user can still browse, just sees a persistent (or
 * dismissible-for-this-session) reminder that their email is
 * unverified, with a one-tap "Resend" button.
 *
 * Withdrawals + weekly digest delivery are the only hard gates; the
 * banner explains what's locked so the user understands the value of
 * clicking the link in their inbox.
 *
 * Dismiss state lives in sessionStorage so it auto-clears when the
 * tab closes — re-shown on next visit, prevents annoying-forever
 * permadismiss while staying out of the user's way mid-session.
 */

import { useState, useEffect } from 'react'
import { MailCheck, X, Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { auth as authApi } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

const DISMISS_KEY = 'a2e_verify_email_banner_dismissed'

export function VerifyEmailBanner() {
  const { user, loading } = useAuth()
  const { toast } = useToast()
  const [dismissed, setDismissed] = useState(false)
  const [resending, setResending] = useState(false)
  const [justSent, setJustSent] = useState(false)

  // Hydrate dismiss state from sessionStorage on mount. SSR-safe via
  // the typeof window check.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === '1') setDismissed(true)
    } catch {
      /* sessionStorage can throw in private mode; safe to ignore */
    }
  }, [])

  if (loading) return null
  if (!user) return null
  if (user.emailVerified) return null
  if (!user.email) return null // wallet-only accounts have no email to verify
  if (dismissed) return null

  const handleResend = async () => {
    setResending(true)
    try {
      await authApi.sendVerification()
      toast('success', `Verification email sent to ${user.email}`)
      setJustSent(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send verification email'
      // The API returns "Email is already verified" if the user verified
      // in another tab. Treat that as a soft-success — the banner will
      // disappear on the next useAuth refresh.
      if (msg.toLowerCase().includes('already verified')) {
        toast('success', 'Your email is already verified. Refresh to update.')
        setJustSent(true)
      } else {
        toast('error', msg)
      }
    } finally {
      setResending(false)
    }
  }

  const handleDismiss = () => {
    setDismissed(true)
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private mode etc. — dismissal stays in-memory only */
    }
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg"
      style={{
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.28)',
        color: 'var(--text-primary)',
      }}
    >
      <MailCheck size={16} style={{ color: '#f59e0b' }} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {justSent ? 'Check your inbox' : 'Verify your email'}
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
          {justSent ? (
            <>
              We re-sent a verification link to{' '}
              <span className="font-mono">{user.email}</span>. Click it to enable
              withdrawals and the weekly compute report.
            </>
          ) : (
            <>
              We sent a link to <span className="font-mono">{user.email}</span>.
              Verified accounts can withdraw earnings and receive the weekly
              compute report.
            </>
          )}
        </p>
      </div>
      {!justSent && (
        <button
          type="button"
          onClick={handleResend}
          disabled={resending}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium transition-colors disabled:opacity-60"
          style={{
            background: '#f59e0b',
            color: '#0a0a0f',
          }}
        >
          {resending && <Loader2 size={12} className="animate-spin" />}
          {resending ? 'Sending…' : 'Resend email'}
        </button>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-foreground/5 transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
