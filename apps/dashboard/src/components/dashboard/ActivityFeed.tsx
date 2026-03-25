'use client'

import { useSocket, SocketEvent } from '@/hooks/useWebSocket'
import { Card } from '@/components/ui/Card'

type EventType = 'node:registered' | 'node:offline' | 'job:routed' | 'job:failed' | 'rate:updated' | 'system' | 'error'

const eventConfig: Record<EventType, { icon: React.ReactNode; color: string; bg: string; border: string }> = {
  'node:registered': {
    icon: <NodePlusIcon />,
    color: 'text-accent',
    bg: 'bg-accent/10',
    border: 'border-accent/30',
  },
  'node:offline': {
    icon: <NodeMinusIcon />,
    color: 'text-error',
    bg: 'bg-error/10',
    border: 'border-error/30',
  },
  'job:routed': {
    icon: <RouteIcon />,
    color: 'text-accent-blue',
    bg: 'bg-accent-blue/10',
    border: 'border-accent-blue/30',
  },
  'job:failed': {
    icon: <AlertIcon />,
    color: 'text-error',
    bg: 'bg-error/10',
    border: 'border-error/30',
  },
  'rate:updated': {
    icon: <DollarIcon />,
    color: 'text-accent-purple',
    bg: 'bg-accent-purple/10',
    border: 'border-accent-purple/30',
  },
  system: {
    icon: <BoltIcon />,
    color: 'text-accent',
    bg: 'bg-accent/10',
    border: 'border-accent/30',
  },
  error: {
    icon: <WarningIcon />,
    color: 'text-warning',
    bg: 'bg-warning/10',
    border: 'border-warning/30',
  },
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

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function ActivityFeed() {
  const { connected, events, clearEvents } = useSocket()

  return (
    <Card variant="glass" hover={false} padding="none" className="overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`
            relative flex h-2.5 w-2.5
          `}>
            {connected && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            )}
            <span className={`
              relative inline-flex rounded-full h-2.5 w-2.5
              ${connected ? 'bg-accent' : 'bg-error'}
            `} />
          </div>
          <h3 className="font-semibold text-text-primary">Live Activity</h3>
          <span className="text-xs text-text-muted bg-surface px-2 py-0.5 rounded-full">
            {events.length} events
          </span>
        </div>
        {events.length > 0 && (
          <button
            onClick={clearEvents}
            className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-surface-hover transition-colors"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Events */}
      <div className="max-h-[400px] overflow-y-auto">
        {events.length === 0 ? (
          <div className="p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-surface-hover flex items-center justify-center mx-auto mb-3">
              <BoltIcon className="w-6 h-6 text-text-muted" />
            </div>
            <p className="text-text-muted text-sm">
              {connected ? 'Waiting for events...' : 'Connecting to WebSocket...'}
            </p>
            {!connected && (
              <p className="text-text-muted text-xs mt-1">
                Events will appear here in real-time
              </p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {events.map((event, index) => {
              const config = eventConfig[event.type as EventType] || eventConfig.system
              const description = getEventDescription(event)

              return (
                <div
                  key={event.id}
                  className={`
                    p-4 border-l-2 ${config.border}
                    hover:bg-surface-hover/50
                    transition-all duration-300
                    ${index === 0 ? 'animate-slideUp' : ''}
                  `}
                >
                  <div className="flex items-start gap-3">
                    <div className={`
                      w-8 h-8 rounded-lg flex items-center justify-center shrink-0
                      ${config.bg} ${config.color}
                    `}>
                      {config.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">
                        {getEventTitle(event)}
                      </p>
                      {description && (
                        <p className="text-xs text-text-muted truncate mt-0.5">
                          {description}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-text-muted whitespace-nowrap tabular-nums">
                      {formatTime(event.timestamp)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-border/50 bg-surface/50">
        <div className="flex items-center justify-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-accent' : 'bg-error'}`} />
          <p className={`text-xs ${connected ? 'text-accent' : 'text-error'}`}>
            {connected ? 'Connected to WebSocket' : 'Disconnected'}
          </p>
        </div>
      </div>
    </Card>
  )
}

export function ActivityIndicator() {
  const { connected, lastEvent } = useSocket()

  return (
    <div className="flex items-center gap-2">
      <span className={`
        w-2 h-2 rounded-full
        ${connected ? 'bg-accent animate-pulse' : 'bg-error'}
      `} />
      {lastEvent && (
        <span className="text-xs text-text-muted truncate max-w-32">
          {getEventTitle(lastEvent)}
        </span>
      )}
    </div>
  )
}

// Icons
function NodePlusIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
    </svg>
  )
}

function NodeMinusIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
    </svg>
  )
}

function RouteIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
    </svg>
  )
}

function AlertIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}

function DollarIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
    </svg>
  )
}

function BoltIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  )
}

function WarningIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}
