'use client'

/*
 * Role-aware onboarding callout. Shows the first time a user visits
 * the "other" side of the portal via the dual-role view switcher.
 *
 * Detection:
 *   - On /buyer/*    -> show if !user.isBuyer
 *   - On /dashboard* -> show if !user.isNodeRunner
 *
 * Dismiss action:
 *   - "Enable" POSTs to /v1/portal/auth/add-role and flips the flag
 *     server-side. Returns refreshed flags; we update local state.
 *   - "Not now" stores a localStorage flag so we don't nag again
 *     this session (the user can still call add-role from Settings
 *     later).
 *
 * Once the user has the matching flag, the callout never shows again.
 */

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ArrowRight, Sparkles } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch } from '@/lib/api'

type Surface = 'buyer' | 'runner' | null

function dismissKey(surface: Surface) {
  return surface === 'buyer'
    ? 'tokenos-buyer-intro-dismissed'
    : 'tokenos-runner-intro-dismissed'
}

export function RoleIntroCallout() {
  const { user, refresh } = useAuth()
  const pathname = usePathname()
  const [enabling, setEnabling] = useState(false)
  const [dismissed, setDismissed] = useState<Surface>(null)
  const [acked, setAcked] = useState<Set<string>>(new Set())

  // Load localStorage dismissals on mount so we don't flash the
  // callout for a user who already said "not now."
  useEffect(() => {
    if (typeof window === 'undefined') return
    const next = new Set<string>()
    for (const k of [dismissKey('buyer'), dismissKey('runner')]) {
      if (localStorage.getItem(k) === '1') next.add(k)
    }
    setAcked(next)
  }, [])

  if (!user || !pathname) return null

  const onBuyer = pathname.startsWith('/buyer')
  const onRunner = pathname.startsWith('/dashboard')

  // Pick a surface to consider. If neither, no callout.
  const surface: Surface = onBuyer ? 'buyer' : onRunner ? 'runner' : null
  if (!surface) return null

  // Skip if the user already has the matching flag, or session-dismissed.
  const hasFlag = surface === 'buyer' ? user.isBuyer : user.isNodeRunner
  if (hasFlag) return null
  if (dismissed === surface) return null
  if (acked.has(dismissKey(surface))) return null

  async function enable() {
    if (!surface) return
    setEnabling(true)
    try {
      await apiFetch<{ isBuyer: boolean; isNodeRunner: boolean }>(
        '/v1/portal/auth/add-role',
        {
          method: 'POST',
          body: { role: surface === 'buyer' ? 'COMPUTE_BUYER' : 'NODE_RUNNER' },
        },
      )
      // Refetch the user from /me so the new isBuyer/isNodeRunner flag
      // reaches the React tree. Without this the callout would reappear
      // on the next portal switch because useAuth.user was still stale.
      await refresh()
      setDismissed(surface)
    } catch (err) {
      console.warn('add-role failed', err)
    } finally {
      setEnabling(false)
    }
  }

  function notNow() {
    if (!surface) return
    try {
      localStorage.setItem(dismissKey(surface), '1')
    } catch { /* ignore */ }
    setDismissed(surface)
  }

  const isBuyerSurface = surface === 'buyer'

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: 0.25 }}
        className="relative mb-6 rounded-md border border-accent/40 bg-accent/5 p-4 sm:p-6"
      >
        <button
          type="button"
          onClick={notNow}
          aria-label="Dismiss"
          className="absolute top-3 right-3 text-text-muted hover:text-text-primary"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="shrink-0 flex items-center justify-center w-10 h-10 rounded-md bg-accent/15 text-accent">
            <Sparkles className="w-5 h-5" />
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="font-display text-lg text-text-primary mb-2">
              {isBuyerSurface
                ? "Welcome to the Buyer's Portal"
                : 'Welcome to the Node Runner side'}
            </h3>
            <p className="text-sm text-text-secondary leading-relaxed mb-4">
              {isBuyerSurface
                ? 'This is where you rent GPU compute by the minute. Top up your wallet, submit a request, and SSH into a GPU in under sixty seconds. Enabling buyer access lets your account act on this side without affecting your operator setup.'
                : 'This is where you list your GPUs and earn for hosting compute. Install the agent on your machine, watch heartbeats roll in, track earnings, and withdraw. Enabling node runner access lets your account act on this side without affecting your buyer setup.'}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={enable}
                disabled={enabling}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-60"
              >
                {enabling
                  ? 'Enabling...'
                  : isBuyerSurface
                  ? 'Enable buyer access'
                  : 'Enable node runner access'}
                <ArrowRight className="w-4 h-4" />
              </button>

              {!isBuyerSurface && (
                <Link
                  href="/onboarding"
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                >
                  See the install wizard
                </Link>
              )}

              <button
                type="button"
                onClick={notNow}
                className="text-sm text-text-muted hover:text-text-primary transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
