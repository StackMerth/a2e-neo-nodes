'use client'

/**
 * TokenOS DeAI branded loading indicator. Blinking square with the TokenOS DeAI wordmark.
 *
 * Usage:
 *   <A2ELoader />                          // full-screen, default message
 *   <A2ELoader fullScreen={false} />       // inline (e.g. inside a card)
 *   <A2ELoader message="Saving" />          // custom verb (defaults to "Loading")
 */

interface A2ELoaderProps {
  message?: string
  fullScreen?: boolean
}

export function A2ELoader({ message = 'Loading', fullScreen = true }: A2ELoaderProps) {
  const containerClass = fullScreen
    ? 'fixed inset-0 flex flex-col items-center justify-center z-50'
    : 'flex flex-col items-center justify-center py-12'

  return (
    <div
      className={containerClass}
      style={fullScreen ? { background: 'var(--bg-dark)' } : undefined}
      role="status"
      aria-live="polite"
      aria-label={`${message}...`}
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4 animate-pulse"
        style={{
          background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
          boxShadow: '0 12px 32px rgba(34, 197, 94, 0.35), 0 0 0 1px rgba(34, 197, 94, 0.2)',
        }}
      >
        <span className="font-bold text-2xl tracking-tight" style={{ color: '#0a0a0f' }}>
          TokenOS DeAI
        </span>
      </div>
      {message && (
        <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>
          {message}…
        </p>
      )}
    </div>
  )
}

export default A2ELoader
