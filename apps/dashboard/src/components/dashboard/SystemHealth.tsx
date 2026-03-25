'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { api } from '@/lib/api'

interface HealthStatus {
  status: string
  timestamp: string
  services?: {
    database?: { status: string; latency?: number }
    redis?: { status: string; latency?: number }
    akash?: { status: string; lastFetch?: string }
    ionet?: { status: string; lastFetch?: string }
  }
}

type ServiceStatus = 'healthy' | 'degraded' | 'error' | 'unknown'

const statusConfig: Record<ServiceStatus, { color: string; bg: string; glow: string; label: string }> = {
  healthy: {
    color: 'text-accent',
    bg: 'bg-accent',
    glow: 'shadow-[0_0_8px_rgba(34,197,94,0.5)]',
    label: 'Healthy',
  },
  degraded: {
    color: 'text-warning',
    bg: 'bg-warning',
    glow: 'shadow-[0_0_8px_rgba(245,158,11,0.5)]',
    label: 'Degraded',
  },
  error: {
    color: 'text-error',
    bg: 'bg-error',
    glow: 'shadow-[0_0_8px_rgba(239,68,68,0.5)]',
    label: 'Error',
  },
  unknown: {
    color: 'text-text-muted',
    bg: 'bg-text-muted',
    glow: '',
    label: 'Unknown',
  },
}

function getServiceStatus(status: string): ServiceStatus {
  const normalized = status?.toLowerCase()
  if (['ok', 'healthy', 'connected'].includes(normalized)) return 'healthy'
  if (['degraded', 'slow'].includes(normalized)) return 'degraded'
  if (['error', 'disconnected', 'unavailable'].includes(normalized)) return 'error'
  return 'unknown'
}

const serviceIcons: Record<string, React.ReactNode> = {
  API: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
    </svg>
  ),
  Database: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  ),
  Redis: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    </svg>
  ),
  Akash: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  'IO.net': (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
    </svg>
  ),
}

export function SystemHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkHealth()
    const interval = setInterval(checkHealth, 30000)
    return () => clearInterval(interval)
  }, [])

  async function checkHealth() {
    try {
      const data = await api.health.detailed()
      setHealth(data as HealthStatus)
    } catch {
      setHealth({ status: 'error', timestamp: new Date().toISOString() })
    } finally {
      setLoading(false)
    }
  }

  const services = [
    { name: 'API', status: health?.status || 'unknown', latency: undefined },
    { name: 'Database', status: health?.services?.database?.status || 'unknown', latency: health?.services?.database?.latency },
    { name: 'Redis', status: health?.services?.redis?.status || 'unknown', latency: health?.services?.redis?.latency },
    { name: 'Akash', status: health?.services?.akash?.status || 'unknown' },
    { name: 'IO.net', status: health?.services?.ionet?.status || 'unknown' },
  ]

  const healthyCount = services.filter(s => getServiceStatus(s.status) === 'healthy').length
  const allHealthy = healthyCount === services.length

  if (loading) {
    return (
      <Card variant="glass" hover={false}>
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-surface-hover rounded w-32" />
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-12 bg-surface-hover rounded-lg" />
            ))}
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card variant="glass" hover={false}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">System Health</h3>
        <div className={`
          flex items-center gap-2 px-3 py-1.5 rounded-full
          ${allHealthy
            ? 'bg-accent/10 border border-accent/20'
            : 'bg-warning/10 border border-warning/20'
          }
        `}>
          <span className={`
            relative flex h-2 w-2
          `}>
            <span className={`
              animate-ping absolute inline-flex h-full w-full rounded-full opacity-75
              ${allHealthy ? 'bg-accent' : 'bg-warning'}
            `} />
            <span className={`
              relative inline-flex rounded-full h-2 w-2
              ${allHealthy ? 'bg-accent' : 'bg-warning'}
            `} />
          </span>
          <span className={`text-xs font-medium ${allHealthy ? 'text-accent' : 'text-warning'}`}>
            {allHealthy ? 'All Operational' : `${healthyCount}/${services.length} Healthy`}
          </span>
        </div>
      </div>

      {/* Services List */}
      <div className="space-y-2">
        {services.map((service) => {
          const status = getServiceStatus(service.status)
          const config = statusConfig[status]

          return (
            <div
              key={service.name}
              className={`
                flex items-center justify-between p-3 rounded-lg
                bg-surface/50 border border-border/50
                transition-all duration-300
                hover:border-border hover:bg-surface
              `}
            >
              <div className="flex items-center gap-3">
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center
                  ${status === 'healthy' ? 'bg-accent/10 text-accent' :
                    status === 'degraded' ? 'bg-warning/10 text-warning' :
                    status === 'error' ? 'bg-error/10 text-error' :
                    'bg-surface-hover text-text-muted'}
                `}>
                  {serviceIcons[service.name]}
                </div>
                <span className="text-sm font-medium text-text-primary">{service.name}</span>
              </div>

              <div className="flex items-center gap-3">
                {service.latency !== undefined && (
                  <span className="text-xs text-text-muted tabular-nums">
                    {service.latency}ms
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <span className={`
                    w-2 h-2 rounded-full ${config.bg} ${config.glow}
                  `} />
                  <span className={`text-xs font-medium ${config.color}`}>
                    {config.label}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-border/50 flex items-center justify-center">
        <p className="text-xs text-text-muted">
          Last checked: {health?.timestamp
            ? new Date(health.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })
            : 'N/A'
          }
        </p>
      </div>
    </Card>
  )
}

export function HealthIndicator() {
  const [status, setStatus] = useState<'loading' | 'healthy' | 'degraded' | 'error'>('loading')

  useEffect(() => {
    checkHealth()
    const interval = setInterval(checkHealth, 30000)
    return () => clearInterval(interval)
  }, [])

  async function checkHealth() {
    try {
      const data = await api.health.check()
      setStatus(data.status === 'ok' ? 'healthy' : 'degraded')
    } catch {
      setStatus('error')
    }
  }

  const config = status === 'loading'
    ? { color: 'text-text-muted', bg: 'bg-text-muted', label: 'Checking...' }
    : statusConfig[status]

  return (
    <div className="flex items-center gap-2">
      <span className={`
        w-2 h-2 rounded-full ${config.bg}
        ${status === 'loading' ? 'animate-pulse' : ''}
      `} />
      <span className={`text-xs ${config.color}`}>
        {config.label}
      </span>
    </div>
  )
}
