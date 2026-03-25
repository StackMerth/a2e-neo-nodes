'use client'

import { useSocket, SocketEvent } from '@/hooks/useWebSocket'

function getEventIcon(type: string): string {
  switch (type) {
    case 'node:registered': return '🟢'
    case 'node:offline': return '🔴'
    case 'job:routed': return '🔀'
    case 'job:failed': return '❌'
    case 'rate:updated': return '💰'
    case 'system': return '⚡'
    case 'error': return '⚠️'
    default: return '📌'
  }
}

function getEventTitle(event: SocketEvent): string {
  switch (event.type) {
    case 'node:registered':
      return `Node registered (${event.data.gpuTier})`
    case 'node:offline':
      return `Node went offline`
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

function getEventDescription(event: SocketEvent): string | null {
  switch (event.type) {
    case 'node:registered':
      return `Wallet: ${String(event.data.walletAddress).slice(0, 10)}...`
    case 'job:routed':
      return `${event.data.deploymentId} at $${((event.data.rate as number) * 24).toFixed(2)}/day`
    case 'job:failed':
      return String(event.data.error).slice(0, 50)
    case 'rate:updated':
      return `${event.data.gpuTier}: $${((event.data.ratePerHour as number) * 24).toFixed(2)}/day`
    default:
      return null
  }
}

function getEventColor(type: string): string {
  switch (type) {
    case 'node:registered': return 'border-accent'
    case 'node:offline': return 'border-error'
    case 'job:routed': return 'border-blue-500'
    case 'job:failed': return 'border-error'
    case 'rate:updated': return 'border-purple-500'
    case 'system': return 'border-accent'
    case 'error': return 'border-warning'
    default: return 'border-border'
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function ActivityFeed() {
  const { connected, events, clearEvents } = useSocket()

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-accent animate-pulse' : 'bg-error'}`} />
          <h3 className="font-medium text-text-primary text-sm">Live Activity</h3>
        </div>
        {events.length > 0 && (
          <button
            onClick={clearEvents}
            className="text-xs text-text-muted hover:text-text-primary"
          >
            Clear
          </button>
        )}
      </div>

      {/* Events */}
      <div className="max-h-80 overflow-y-auto">
        {events.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            {connected ? 'Waiting for events...' : 'Connecting...'}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {events.map((event) => (
              <div
                key={event.id}
                className={`p-3 border-l-2 ${getEventColor(event.type)} hover:bg-surface-hover transition-colors`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-sm">{getEventIcon(event.type)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary truncate">
                      {getEventTitle(event)}
                    </p>
                    {getEventDescription(event) && (
                      <p className="text-xs text-text-muted truncate">
                        {getEventDescription(event)}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-text-muted whitespace-nowrap">
                    {formatTime(event.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-border bg-background">
        <p className="text-xs text-text-muted text-center">
          {connected ? (
            <span className="text-accent">Connected to WebSocket</span>
          ) : (
            <span className="text-error">Disconnected</span>
          )}
        </p>
      </div>
    </div>
  )
}

// Compact version for header/sidebar
export function ActivityIndicator() {
  const { connected, lastEvent } = useSocket()

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-accent animate-pulse' : 'bg-error'}`} />
      {lastEvent && (
        <span className="text-xs text-text-muted truncate max-w-32">
          {getEventTitle(lastEvent)}
        </span>
      )}
    </div>
  )
}
