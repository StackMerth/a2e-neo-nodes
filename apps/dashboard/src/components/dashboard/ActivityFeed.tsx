'use client'

import { useSocket, SocketEvent } from '@/hooks/useWebSocket'
import {
  Plus,
  MinusCircle,
  ArrowRight,
  AlertTriangle,
  DollarSign,
  Zap,
  AlertCircle,
} from 'lucide-react'

/* -----------------------------------------------
   Event config
   ----------------------------------------------- */

type EventType = 'node:registered' | 'node:offline' | 'job:routed' | 'job:failed' | 'rate:updated' | 'system' | 'error'

interface EventStyle {
  icon: React.ReactNode
  dotColor: string
  bgColor: string
}

const EVENT_STYLES: Record<EventType, EventStyle> = {
  'node:registered': {
    icon: <Plus size={14} />,
    dotColor: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.12)',
  },
  'node:offline': {
    icon: <MinusCircle size={14} />,
    dotColor: '#ef4444',
    bgColor: 'rgba(239, 68, 68, 0.12)',
  },
  'job:routed': {
    icon: <ArrowRight size={14} />,
    dotColor: '#3b82f6',
    bgColor: 'rgba(59, 130, 246, 0.12)',
  },
  'job:failed': {
    icon: <AlertTriangle size={14} />,
    dotColor: '#ef4444',
    bgColor: 'rgba(239, 68, 68, 0.12)',
  },
  'rate:updated': {
    icon: <DollarSign size={14} />,
    dotColor: '#8b5cf6',
    bgColor: 'rgba(139, 92, 246, 0.12)',
  },
  system: {
    icon: <Zap size={14} />,
    dotColor: '#22c55e',
    bgColor: 'rgba(34, 197, 94, 0.12)',
  },
  error: {
    icon: <AlertCircle size={14} />,
    dotColor: '#f59e0b',
    bgColor: 'rgba(245, 158, 11, 0.12)',
  },
}

/* -----------------------------------------------
   Helpers
   ----------------------------------------------- */

function getEventTitle(event: SocketEvent): string {
  switch (event.type) {
    case 'node:registered':
      return `Node registered (${event.data.gpuTier})`
    case 'node:offline':
      return 'Node went offline'
    case 'job:routed':
      return `Job routed to ${event.data.market}`
    case 'job:failed':
      return `Job failed${event.data.willRetry ? ' (will retry)' : ''}`
    case 'rate:updated':
      return `${event.data.market} rate updated`
    case 'system':
      return String(event.data.message)
    case 'error':
      return String(event.data.message)
    default:
      return event.type
  }
}

function formatRelativeTime(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/* -----------------------------------------------
   Component
   ----------------------------------------------- */

export function ActivityFeed() {
  const { connected, events, clearEvents } = useSocket()
  const displayEvents = events.slice(0, 10)

  return (
    <div className="dash-chart-card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--space-md) var(--space-lg)',
        borderBottom: '1px solid var(--glass-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: connected ? '#22c55e' : '#ef4444',
            boxShadow: connected ? '0 0 8px rgba(34, 197, 94, 0.5)' : 'none',
          }} />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            Recent Activity
          </h3>
          <span style={{
            fontSize: '0.7rem', color: 'var(--text-muted)',
            background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 'var(--radius-full)',
          }}>
            {events.length} events
          </span>
        </div>
        {events.length > 0 && (
          <button
            onClick={clearEvents}
            style={{
              fontSize: '0.75rem', color: 'var(--text-muted)', background: 'none',
              border: 'none', cursor: 'pointer', padding: '4px 8px',
              borderRadius: 'var(--radius-sm)',
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'var(--text-muted)' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Events list */}
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {displayEvents.length === 0 ? (
          <div style={{
            padding: 'var(--space-2xl) var(--space-lg)', textAlign: 'center',
          }}>
            <Zap size={24} style={{ color: 'var(--text-muted)', margin: '0 auto var(--space-sm)' }} />
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
              {connected ? 'Waiting for events...' : 'Connecting to WebSocket...'}
            </p>
          </div>
        ) : (
          displayEvents.map((event, index) => {
            const style = EVENT_STYLES[event.type as EventType] ?? EVENT_STYLES.system
            return (
              <div
                key={event.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-md)',
                  padding: 'var(--space-md) var(--space-lg)',
                  borderBottom: index < displayEvents.length - 1 ? '1px solid var(--glass-border)' : 'none',
                  transition: 'background var(--transition-fast)',
                  cursor: 'default',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 'var(--radius-md)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: style.bgColor, color: style.dotColor, flexShrink: 0,
                }}>
                  {style.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-primary)',
                    margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {getEventTitle(event)}
                  </p>
                </div>
                <span style={{
                  fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {formatRelativeTime(event.timestamp)}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/* -----------------------------------------------
   Compact Activity Indicator (sidebar, header)
   ----------------------------------------------- */

export function ActivityIndicator() {
  const { connected, lastEvent } = useSocket()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: connected ? '#22c55e' : '#ef4444',
        ...(connected ? { animation: 'pulse 2s ease-in-out infinite' } : {}),
      }} />
      {lastEvent && (
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 128 }}>
          {getEventTitle(lastEvent)}
        </span>
      )}
    </div>
  )
}
