'use client'

/**
 * Offline banner. Visible at the top of the page when EITHER:
 *   - The browser reports navigator.onLine === false (true offline)
 *   - OR apiFetch served any GET response from the IndexedDB cache
 *     in the last 10 seconds (fired via the a2e:cache-fallback event)
 *
 * Auto-hides ~5 s after navigator.onLine flips back to true and after
 * the most recent cache fallback ages out. Keeps the UX clear: when
 * the operator sees data, they know whether it's live or stale.
 */

import { useEffect, useState } from 'react'
import { WifiOff, RefreshCw } from 'lucide-react'

const CACHE_FALLBACK_TTL_MS = 10_000

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export function OfflineBanner() {
  const [online, setOnline] = useState(true)
  const [lastCacheFallback, setLastCacheFallback] = useState<number | null>(null)

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setOnline(navigator.onLine)
    }
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    const onFallback = (e: Event) => {
      const detail = (e as CustomEvent<{ cachedAt: number }>).detail
      setLastCacheFallback(detail?.cachedAt ?? Date.now())
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('a2e:cache-fallback', onFallback)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('a2e:cache-fallback', onFallback)
    }
  }, [])

  // Auto-expire the cache-fallback signal so the banner fades when
  // requests start succeeding live again.
  const [, force] = useState(0)
  useEffect(() => {
    if (!lastCacheFallback) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [lastCacheFallback])

  const fallbackActive =
    lastCacheFallback !== null && Date.now() - lastCacheFallback < CACHE_FALLBACK_TTL_MS
  const showBanner = !online || (online && fallbackActive)

  if (!showBanner) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs"
      style={{
        background: !online ? 'rgba(245,158,11,0.10)' : 'rgba(59,130,246,0.10)',
        borderBottom: !online ? '1px solid rgba(245,158,11,0.25)' : '1px solid rgba(59,130,246,0.25)',
        color: !online ? 'var(--warning, #f59e0b)' : 'var(--info, #3b82f6)',
      }}
    >
      {!online ? (
        <>
          <WifiOff size={14} />
          <span>You&rsquo;re offline. Showing cached data{lastCacheFallback ? ` from ${timeAgo(lastCacheFallback)}` : ''}.</span>
        </>
      ) : (
        <>
          <RefreshCw size={14} className="animate-spin" />
          <span>Reconnecting&hellip; showing cached data from {timeAgo(lastCacheFallback!)}.</span>
        </>
      )}
    </div>
  )
}
