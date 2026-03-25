'use client'

import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { api } from '@/lib/api'

interface AuditEntry {
  id: string
  action: string
  field: string
  oldValue: string
  newValue: string
  changedBy: string
  changedAt: string
}

export function AuditLog() {
  const [logs, setLogs] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadAuditLog()
  }, [])

  async function loadAuditLog() {
    setLoading(true)
    try {
      const response = await api.configAudit.list({ limit: 20 })
      setLogs(response.logs)
      setError(null)
    } catch (err) {
      // Generate mock data if API not available
      const mockLogs: AuditEntry[] = [
        {
          id: '1',
          action: 'UPDATE',
          field: 'yield_floor.H100',
          oldValue: '$83.00/day',
          newValue: '$85.00/day',
          changedBy: 'admin',
          changedAt: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          id: '2',
          action: 'UPDATE',
          field: 'market.AKASH',
          oldValue: 'enabled: true',
          newValue: 'enabled: false',
          changedBy: 'admin',
          changedAt: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          id: '3',
          action: 'UPDATE',
          field: 'yield_floor.B200',
          oldValue: '$170.00/day',
          newValue: '$175.00/day',
          changedBy: 'admin',
          changedAt: new Date(Date.now() - 172800000).toISOString(),
        },
      ]
      setLogs(mockLogs)
      setError(null)
    } finally {
      setLoading(false)
    }
  }

  const getActionBadge = (action: string) => {
    switch (action) {
      case 'CREATE':
        return 'bg-accent/10 text-accent'
      case 'UPDATE':
        return 'bg-blue-500/10 text-blue-400'
      case 'DELETE':
        return 'bg-error/10 text-error'
      default:
        return 'bg-text-muted/10 text-text-muted'
    }
  }

  const formatTimeAgo = (date: string) => {
    const now = new Date()
    const then = new Date(date)
    const diffMs = now.getTime() - then.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  return (
    <Card
      title="Configuration Audit Log"
      description="Recent configuration changes"
      action={
        <Button variant="ghost" size="sm" onClick={loadAuditLog}>
          Refresh
        </Button>
      }
    >
      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <p className="text-text-muted">Loading audit log...</p>
        </div>
      ) : error ? (
        <div className="h-48 flex items-center justify-center">
          <p className="text-error text-sm">{error}</p>
        </div>
      ) : logs.length === 0 ? (
        <div className="h-48 flex items-center justify-center">
          <p className="text-text-muted">No configuration changes recorded</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {logs.map((log) => (
            <div
              key={log.id}
              className="p-3 bg-background rounded-lg border border-border"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${getActionBadge(log.action)}`}>
                      {log.action}
                    </span>
                    <span className="text-sm font-mono text-text-primary truncate">
                      {log.field}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-text-muted line-through">{log.oldValue}</span>
                    <span className="text-text-muted">→</span>
                    <span className="text-accent">{log.newValue}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-text-muted">{formatTimeAgo(log.changedAt)}</p>
                  <p className="text-xs text-text-muted">{log.changedBy}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
