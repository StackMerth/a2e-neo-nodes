'use client'

/**
 * C6 wave 2: PWA offline fallback page.
 *
 * Routed by next-pwa's `fallbacks.document` when the installed PWA
 * (or any browser tab with the SW active) tries to navigate to a
 * route that isn't in the runtime cache while offline.
 *
 * Renders the brand wordmark + a brief "you're offline" message so
 * the standalone PWA never falls through to Chrome's generic
 * ERR_INTERNET_DISCONNECTED page. The shell pulls only inline-safe
 * resources — no API fetches, no analytics, no font imports outside
 * the system stack — so this page is guaranteed to render with
 * nothing but the cached HTML/CSS payload.
 */

export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '24px',
        padding: '32px',
        background: '#0a0a0f',
        color: '#ffffff',
        fontFamily:
          "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontWeight: 800,
          fontSize: '40px',
          letterSpacing: '-1px',
          lineHeight: 1,
        }}
      >
        <span style={{ color: '#ffffff' }}>TokenOS</span>
        <span style={{ color: '#22c55e' }}>_DeAI</span>
      </div>

      <p
        style={{
          fontSize: '14px',
          color: '#71717a',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          margin: 0,
        }}
      >
        You're offline
      </p>

      <p
        style={{
          fontSize: '16px',
          color: '#cbd5e1',
          maxWidth: '440px',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        This page needs a network connection to load. Reconnect and try
        again, or pull up a page you've already opened today &mdash;
        those will still work from the local cache.
      </p>

      <button
        type="button"
        onClick={() => {
          if (typeof window !== 'undefined') window.location.reload()
        }}
        style={{
          marginTop: '8px',
          padding: '12px 24px',
          background: '#22c55e',
          color: '#0a0a0f',
          fontWeight: 700,
          fontSize: '14px',
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          borderRadius: '6px',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        Retry
      </button>
    </main>
  )
}
