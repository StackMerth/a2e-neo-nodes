'use client'

import { useEffect, useState } from 'react'
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

export function SystemHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkHealth()
    const interval = setInterval(checkHealth, 30000) // Check every 30s
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

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'ok':
      case 'healthy':
      case 'connected':
        return 'bg-accent'
      case 'degraded':
      case 'slow':
        return 'bg-warning'
      case 'error':
      case 'disconnected':
      case 'unavailable':
        return 'bg-error'
      default:
        return 'bg-text-muted'
    }
  }

  const getStatusText = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'ok':
      case 'healthy':
      case 'connected':
        return 'Healthy'
      case 'degraded':
      case 'slow':
        return 'Degraded'
      case 'error':
      case 'disconnected':
      case 'unavailable':
        return 'Error'
      default:
        return 'Unknown'
    }
  }

  if (loading) {
    return (
      <div className="p-4 bg-surface border border-border rounded-lg">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-background rounded w-24" />
          <div className="h-3 bg-background rounded w-full" />
          <div className="h-3 bg-background rounded w-full" />
        </div>
      </div>
    )
  }

  const services = [
    { name: 'API', status: health?.status || 'unknown' },
    { name: 'Database', status: health?.services?.database?.status || 'unknown', latency: health?.services?.database?.latency },
    { name: 'Redis', status: health?.services?.redis?.status || 'unknown', latency: health?.services?.redis?.latency },
    { name: 'Akash', status: health?.services?.akash?.status || 'unknown' },
    { name: 'IO.net', status: health?.services?.ionet?.status || 'unknown' },
  ]

  const allHealthy = services.every(s =>
    ['ok', 'healthy', 'connected'].includes(s.status?.toLowerCase())
  )

  return (
    <div className="p-4 bg-surface border border-border rounded-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium text-text-primary text-sm">System Health</h3>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${allHealthy ? 'bg-accent' : 'bg-warning'}`} />
          <span className="text-xs text-text-muted">
            {allHealthy ? 'All Systems Operational' : 'Degraded'}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {services.map((service) => (
          <div
            key={service.name}
            className="flex items-center justify-between py-2 px-3 bg-background rounded"
          >
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${getStatusColor(service.status)}`} />
              <span className="text-sm text-text-primary">{service.name}</span>
            </div>
            <div className="flex items-center gap-2">
              {service.latency && (
                <span className="text-xs text-text-muted">{service.latency}ms</span>
              )}
              <span className={`text-xs ${
                ['ok', 'healthy', 'connected'].includes(service.status?.toLowerCase())
                  ? 'text-accent'
                  : ['degraded', 'slow'].includes(service.status?.toLowerCase())
                  ? 'text-warning'
                  : 'text-error'
              }`}>
                {getStatusText(service.status)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-text-muted mt-3 text-center">
        Last checked: {health?.timestamp ? new Date(health.timestamp).toLocaleTimeString() : 'N/A'}
      </p>
    </div>
  )
}

// Compact version for header
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

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${
        status === 'healthy' ? 'bg-accent' :
        status === 'degraded' ? 'bg-warning' :
        status === 'error' ? 'bg-error' : 'bg-text-muted animate-pulse'
      }`} />
      <span className="text-xs text-text-muted">
        {status === 'healthy' ? 'Healthy' :
         status === 'degraded' ? 'Degraded' :
         status === 'error' ? 'Error' : 'Checking...'}
      </span>
    </div>
  )
}
