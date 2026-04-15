'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Server,
  Database,
  HardDrive,
  Globe,
} from 'lucide-react'
import { api } from '@/lib/api'

/* -----------------------------------------------
   Types
   ----------------------------------------------- */

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

interface ServiceEntry {
  name: string
  icon: React.ReactNode
  status: ServiceStatus
  detail: string
}

/* -----------------------------------------------
   Helpers
   ----------------------------------------------- */

function resolveStatus(raw: string | undefined): ServiceStatus {
  if (!raw) return 'unknown'
  const normalized = raw.toLowerCase()
  if (['ok', 'healthy', 'connected'].includes(normalized)) return 'healthy'
  if (['degraded', 'slow'].includes(normalized)) return 'degraded'
  if (['error', 'disconnected', 'unavailable'].includes(normalized)) return 'error'
  return 'unknown'
}

const STATUS_DOT: Record<ServiceStatus, string> = {
  healthy: '#22c55e',
  degraded: '#f59e0b',
  error: '#ef4444',
  unknown: '#71717a',
}

const STATUS_BG: Record<ServiceStatus, string> = {
  healthy: 'rgba(34, 197, 94, 0.12)',
  degraded: 'rgba(245, 158, 11, 0.12)',
  error: 'rgba(239, 68, 68, 0.12)',
  unknown: 'rgba(113, 113, 122, 0.12)',
}

const STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  error: 'Error',
  unknown: 'Unknown',
}

/* -----------------------------------------------
   Component
   ----------------------------------------------- */

export function SystemHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const checkHealth = useCallback(async () => {
    try {
      const data = await api.health.detailed()
      setHealth(data as HealthStatus)
    } catch {
      setHealth({ status: 'error', timestamp: new Date().toISOString() })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    checkHealth()
    const interval = setInterval(checkHealth, 30_000)
    return () => clearInterval(interval)
  }, [checkHealth])

  const services: ServiceEntry[] = [
    {
      name: 'API',
      icon: <Server size={16} />,
      status: resolveStatus(health?.status),
      detail: health?.status === 'ok' ? 'Operational' : (health?.status ?? 'Checking...'),
    },
    {
      name: 'Database',
      icon: <Database size={16} />,
      status: resolveStatus(health?.services?.database?.status),
      detail: health?.services?.database?.latency != null
        ? `${health.services.database.latency}ms`
        : STATUS_LABEL[resolveStatus(health?.services?.database?.status)],
    },
    {
      name: 'Redis',
      icon: <HardDrive size={16} />,
      status: resolveStatus(health?.services?.redis?.status),
      detail: health?.services?.redis?.latency != null
        ? `${health.services.redis.latency}ms`
        : STATUS_LABEL[resolveStatus(health?.services?.redis?.status)],
    },
    {
      name: 'External Markets',
      icon: <Globe size={16} />,
      status: resolveStatus(
        health?.services?.akash?.status === 'ok' && health?.services?.ionet?.status === 'ok'
          ? 'ok'
          : health?.services?.akash?.status === 'error' || health?.services?.ionet?.status === 'error'
          ? 'error'
          : health?.services?.akash?.status ?? health?.services?.ionet?.status,
      ),
      detail: health?.services?.akash
        ? `Akash: ${health.services.akash.status} / IO.net: ${health.services?.ionet?.status ?? '?'}`
        : STATUS_LABEL[resolveStatus(undefined)],
    },
  ]

  if (loading) {
    return (
      <div className="dash-chart-card">
        <h3 className="dash-chart-title">System Health</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-md)' }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-shimmer" style={{ height: 72, borderRadius: 'var(--radius-md)' }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="dash-chart-card">
      <h3 className="dash-chart-title">System Health</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-md)' }}>
        {services.map((svc) => (
          <div
            key={svc.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-md)',
              padding: 'var(--space-md)',
              background: 'var(--glass-bg)',
              border: '1px solid var(--glass-border)',
              borderRadius: 'var(--radius-md)',
              transition: 'all var(--transition-fast)',
            }}
          >
            <div style={{
              width: 36,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-md)',
              background: STATUS_BG[svc.status],
              color: STATUS_DOT[svc.status],
              flexShrink: 0,
            }}>
              {svc.icon}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {svc.name}
                </span>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: STATUS_DOT[svc.status],
                  boxShadow: svc.status === 'healthy'
                    ? `0 0 8px ${STATUS_DOT[svc.status]}`
                    : svc.status === 'error'
                    ? `0 0 8px ${STATUS_DOT[svc.status]}`
                    : 'none',
                  flexShrink: 0,
                }} />
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {svc.detail}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* -----------------------------------------------
   Compact Health Indicator (sidebar, header)
   ----------------------------------------------- */

export function HealthIndicator() {
  const [status, setStatus] = useState<'loading' | 'healthy' | 'degraded' | 'error'>('loading')

  const checkHealth = useCallback(async () => {
    try {
      const data = await api.health.check()
      setStatus(data.status === 'ok' ? 'healthy' : 'degraded')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    checkHealth()
    const interval = setInterval(checkHealth, 30_000)
    return () => clearInterval(interval)
  }, [checkHealth])

  const dotColor = status === 'healthy' ? '#22c55e'
    : status === 'degraded' ? '#f59e0b'
    : status === 'error' ? '#ef4444'
    : '#71717a'

  const label = status === 'loading' ? 'Checking...'
    : status === 'healthy' ? 'Healthy'
    : status === 'degraded' ? 'Degraded'
    : 'Error'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: dotColor,
        ...(status === 'loading' ? { animation: 'pulse 2s ease-in-out infinite' } : {}),
      }} />
      <span style={{ fontSize: '0.75rem', color: dotColor }}>{label}</span>
    </div>
  )
}
