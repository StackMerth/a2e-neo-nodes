'use client'

/**
 * Breathing-orb loader. A pulsing brand-green orb sits above a
 * clean two-tone TokenOS_DeAI wordmark. The orb has three nested
 * layers that breathe at slightly different speeds so it feels
 * alive without being noisy. No text crammed inside the orb so
 * nothing overflows on small screens.
 *
 * Usage:
 *   <A2ELoader />                          // full-screen, default verb
 *   <A2ELoader fullScreen={false} />       // inline (inside a card)
 *   <A2ELoader message="Saving" />          // custom verb
 */

interface A2ELoaderProps {
  message?: string
  fullScreen?: boolean
}

export function A2ELoader({
  message = 'Loading your dashboard',
  fullScreen = true,
}: A2ELoaderProps) {
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
      {/* Breathing orb: three nested rings pulsing at offset rates. */}
      <div className="relative flex items-center justify-center w-32 h-32 mb-8">
        <span className="absolute inset-0 rounded-full bg-accent/25 animate-breath-halo" />
        <span className="absolute inset-4 rounded-full bg-accent/45 animate-breath-mid" />
        <span
          className="absolute inset-10 rounded-full bg-accent animate-breath-core"
          style={{ boxShadow: '0 0 40px rgba(34, 197, 94, 0.55)' }}
        />
      </div>

      <div className="text-2xl font-bold tracking-tight mb-2" style={{ letterSpacing: '-0.02em' }}>
        <span style={{ color: 'var(--text-primary)' }}>TokenOS</span>
        <span style={{ color: 'var(--primary)' }}>_DeAI</span>
      </div>

      {message && (
        <p className="text-xs font-mono uppercase" style={{ color: 'var(--text-muted)', letterSpacing: '0.18em' }}>
          {message}
        </p>
      )}

      <style jsx>{`
        @keyframes breath-halo {
          0%, 100% { transform: scale(0.85); opacity: 0.25; }
          50%      { transform: scale(1.18); opacity: 0.5; }
        }
        @keyframes breath-mid {
          0%, 100% { transform: scale(0.9); opacity: 0.45; }
          50%      { transform: scale(1.1);  opacity: 0.75; }
        }
        @keyframes breath-core {
          0%, 100% { transform: scale(0.95); opacity: 0.85; }
          50%      { transform: scale(1.05); opacity: 1; }
        }
        .animate-breath-halo { animation: breath-halo 2.4s ease-in-out infinite; }
        .animate-breath-mid  { animation: breath-mid 2.1s ease-in-out infinite; }
        .animate-breath-core { animation: breath-core 1.8s ease-in-out infinite; }
      `}</style>
    </div>
  )
}

export default A2ELoader
