'use client'

/*
 * Auth handoff endpoint. Used when the marketplace authenticates a
 * buyer in a modal and needs to land them on the portal already
 * signed in. Tokens are passed via URL fragment (not query string)
 * so they never hit a server log.
 *
 *   /auth/handoff#access=<jwt>&refresh=<jwt>&dest=/buyer/request?gpuTier=H100
 *
 * Behavior:
 *   1. Parse the fragment for access/refresh/dest.
 *   2. Persist tokens to localStorage under the keys the portal's
 *      api client + useAuth already read from.
 *   3. Redirect to `dest` (defaults to /dashboard).
 *   4. If the fragment is missing or malformed, redirect to /login
 *      so the buyer can still authenticate manually.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

function parseHashParams(hash: string): URLSearchParams {
  // hash starts with '#'; strip it before parsing.
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
}

export default function AuthHandoffPage() {
  const router = useRouter()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = parseHashParams(window.location.hash)
    const access = params.get('access')
    const refresh = params.get('refresh')
    const dest = params.get('dest') || '/dashboard'

    if (!access || !refresh) {
      router.replace('/login')
      return
    }

    // Store under the same keys the rest of the portal expects.
    localStorage.setItem('a2e_access_token', access)
    localStorage.setItem('a2e_refresh_token', refresh)

    // Clear the fragment from the URL so a back-button click doesn't
    // re-trigger this page, then move on. Use replace() so /auth/
    // handoff doesn't end up in history.
    window.history.replaceState(null, '', '/auth/handoff')
    router.replace(dest)
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--bg-dark)' }}>
      <div className="text-center">
        <p className="font-display text-2xl tracking-tight" style={{ color: 'var(--text-primary)' }}>
          <span>TokenOS</span>
          <span style={{ color: 'var(--primary)' }}>_DeAI</span>
        </p>
        <p className="font-mono text-xs uppercase tracking-[0.18em] mt-3" style={{ color: 'var(--text-muted)' }}>
          Signing you in
        </p>
      </div>
    </div>
  )
}
