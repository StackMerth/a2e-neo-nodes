'use client'

/**
 * Small dot in the TopHeader reflecting the WebSocket connection
 * state. Lets the user tell at a glance whether real-time updates
 * (compute:tick, notification:new, allocator events, etc.) are
 * arriving, vs. silently dead.
 *
 * The dot lives next to the bell + theme toggle; tooltip on hover
 * explains the current state in plain language. Auto-hidden when the
 * connection is healthy AND the user has been connected for >5s —
 * keeps the header quiet for the 99% case where everything's fine.
 */

import { useEffect, useState } from 'react'
import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useWebSocketStatus, type ConnectionStatus } from '@/hooks/useWebSocket'

const HEALTHY_HIDE_DELAY_MS = 5000

export function ConnectionStatusIndicator() {
  const status = useWebSocketStatus()
  // hidden flips true once we've been continuously connected for the
  // delay window. Any disconnect / reconnect cycle resets it so the
  // indicator briefly re-appears (long enough to register on the
  // operator's eye) and then fades back out.
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (status === 'connected') {
      const t = window.setTimeout(() => setHidden(true), HEALTHY_HIDE_DELAY_MS)
      return () => window.clearTimeout(t)
    }
    setHidden(false)
  }, [status])

  // Even in connected+hidden state we render a zero-width spacer so
  // the header layout doesn't shift when the indicator pops in.
  if (status === 'connected' && hidden) {
    return <span className="w-0 h-0" aria-hidden />
  }

  const config: Record<ConnectionStatus, {
    Icon: typeof Wifi
    color: string
    bg: string
    label: string
    sub: string
    pulse: boolean
  }> = {
    connecting: {
      Icon: Loader2,
      color: '#3b82f6',
      bg: 'rgba(59, 130, 246, 0.12)',
      label: 'Connecting',
      sub: 'Opening live update channel',
      pulse: false,
    },
    connected: {
      Icon: Wifi,
      color: '#22c55e',
      bg: 'rgba(34, 197, 94, 0.12)',
      label: 'Live updates on',
      sub: 'Real-time events streaming',
      pulse: true,
    },
    reconnecting: {
      Icon: Loader2,
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.12)',
      label: 'Reconnecting',
      sub: 'Connection dropped, retrying…',
      pulse: false,
    },
    offline: {
      Icon: WifiOff,
      color: '#ef4444',
      bg: 'rgba(239, 68, 68, 0.12)',
      label: 'Offline',
      sub: 'Waiting for network to come back',
      pulse: false,
    },
  }

  const { Icon, color, bg, label, sub, pulse } = config[status]
  const spinning = status === 'connecting' || status === 'reconnecting'

  return (
    <div
      className="relative group inline-flex items-center justify-center w-9 h-9 rounded-md border border-border shrink-0"
      style={{ background: bg }}
      role="status"
      aria-label={label}
    >
      <Icon
        size={14}
        className={spinning ? 'animate-spin' : pulse ? 'animate-pulse' : ''}
        style={{ color }}
      />
      {/* Hover tooltip — desktop only (touch devices skip it cleanly
          because hover never triggers). Brief enough not to obscure
          the rest of the header. */}
      <div
        className="absolute top-full right-0 mt-2 px-3 py-2 rounded-md shadow-lg whitespace-nowrap text-xs opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-primary)',
        }}
      >
        <p className="font-medium">{label}</p>
        <p style={{ color: 'var(--text-muted)' }}>{sub}</p>
      </div>
    </div>
  )
}
