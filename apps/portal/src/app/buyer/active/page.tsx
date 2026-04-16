'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import {
  Server,
  RefreshCw,
  Copy,
  Check,
  Clock,
  Terminal,
} from 'lucide-react'
import { buyer } from '@/lib/api'
import { Skeleton } from '@/components/ui/Skeleton'
import Link from 'next/link'

interface ActiveAllocation {
  id: string
  requestId: string
  gpuTier: string
  gpuCount: number
  sshHost: string
  sshPort: number
  sshUser: string
  sshPassword?: string
  activatedAt: string
  expiresAt: string
}

const TIER_COLORS: Record<string, string> = {
  H100: '#22c55e',
  H200: '#3b82f6',
  B200: '#8b5cf6',
  B300: '#f59e0b',
  GB300: '#ef4444',
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
}

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-2 p-1 rounded transition-colors hover:bg-white/10"
      title="Copy to clipboard"
    >
      {copied ? <Check size={14} style={{ color: 'var(--primary)' }} /> : <Copy size={14} style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

function TimeRemainingBar({ expiresAt, activatedAt }: { expiresAt: string; activatedAt: string }) {
  const [progress, setProgress] = useState(0)
  const [label, setLabel] = useState('')

  useEffect(() => {
    const update = () => {
      const now = Date.now()
      const start = new Date(activatedAt).getTime()
      const end = new Date(expiresAt).getTime()
      const total = end - start
      const elapsed = now - start
      const pct = Math.min(100, Math.max(0, (elapsed / total) * 100))
      setProgress(pct)

      const remaining = end - now
      if (remaining <= 0) {
        setLabel('Expired')
        return
      }
      const days = Math.floor(remaining / 86400000)
      const hours = Math.floor((remaining % 86400000) / 3600000)
      setLabel(`${days}d ${hours}h remaining`)
    }
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [expiresAt, activatedAt])

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Time Used</span>
        <span className="text-xs font-medium" style={{ color: 'var(--primary)' }}>{label}</span>
      </div>
      <div className="w-full h-2 rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
        <div
          className="h-2 rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, background: 'var(--primary)' }}
        />
      </div>
    </div>
  )
}

export default function ActiveComputePage() {
  const [allocations, setAllocations] = useState<ActiveAllocation[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const data = (await buyer.activeCompute()) as { allocations: ActiveAllocation[] }
      setAllocations(data.allocations ?? [])
    } catch {
      /* silently fail */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(() => loadData(), 30_000)
    return () => clearInterval(interval)
  }, [loadData])

  if (loading) {
    return (
      <div className="space-y-6 animate-fadeIn">
        <Skeleton className="h-14 w-full" />
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-48 w-full" />
        ))}
      </div>
    )
  }

  return (
    <motion.div
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.div className="dash-header" variants={itemVariants}>
        <div className="dash-header-left">
          <h1><Server size={28} /> Active Compute</h1>
        </div>
        <div className="dash-header-right">
          <button
            className="dash-refresh-btn"
            onClick={() => loadData(true)}
            disabled={refreshing}
            title="Refresh data"
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </motion.div>

      {/* Allocation Cards */}
      {allocations.length > 0 ? (
        <motion.div className="space-y-4" variants={containerVariants}>
          {allocations.map((alloc) => {
            const tierColor = TIER_COLORS[alloc.gpuTier] ?? 'var(--primary)'
            return (
              <motion.div key={alloc.id} variants={itemVariants}>
                <div
                  className="rounded-xl p-6"
                  style={{
                    background: 'var(--glass-bg)',
                    border: `1px solid ${tierColor}30`,
                  }}
                >
                  {/* Header Row */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <span
                        className="text-xs font-bold px-3 py-1.5 rounded-lg"
                        style={{ background: `${tierColor}20`, color: tierColor }}
                      >
                        {alloc.gpuTier}
                      </span>
                      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        x{alloc.gpuCount} GPU{alloc.gpuCount > 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <Clock size={12} />
                      Expires {new Date(alloc.expiresAt).toLocaleDateString()}
                    </div>
                  </div>

                  {/* Time Remaining Progress Bar */}
                  <div className="mb-4">
                    <TimeRemainingBar expiresAt={alloc.expiresAt} activatedAt={alloc.activatedAt} />
                  </div>

                  {/* SSH Details */}
                  <div
                    className="rounded-lg p-4"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)' }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <Terminal size={14} style={{ color: tierColor }} />
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>SSH Access</span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center text-xs">
                        <span style={{ color: 'var(--text-muted)', minWidth: 70 }}>Host</span>
                        <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{alloc.sshHost}</span>
                        <CopyButton text={alloc.sshHost} />
                      </div>
                      <div className="flex items-center text-xs">
                        <span style={{ color: 'var(--text-muted)', minWidth: 70 }}>Port</span>
                        <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{alloc.sshPort}</span>
                        <CopyButton text={String(alloc.sshPort)} />
                      </div>
                      <div className="flex items-center text-xs">
                        <span style={{ color: 'var(--text-muted)', minWidth: 70 }}>User</span>
                        <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{alloc.sshUser}</span>
                        <CopyButton text={alloc.sshUser} />
                      </div>
                      {alloc.sshPassword && (
                        <div className="flex items-center text-xs">
                          <span style={{ color: 'var(--text-muted)', minWidth: 70 }}>Password</span>
                          <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{'*'.repeat(12)}</span>
                          <CopyButton text={alloc.sshPassword} />
                        </div>
                      )}
                    </div>
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-color)' }}>
                      <div className="flex items-center text-xs">
                        <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                          ssh {alloc.sshUser}@{alloc.sshHost} -p {alloc.sshPort}
                        </span>
                        <CopyButton text={`ssh ${alloc.sshUser}@${alloc.sshHost} -p ${alloc.sshPort}`} />
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </motion.div>
      ) : (
        <motion.div variants={itemVariants}>
          <div
            className="rounded-xl p-12 text-center"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <Server size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              No active compute
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Your active GPU allocations will appear here once provisioned.
            </p>
            <Link href="/buyer/request">
              <button className="btn btn-primary mt-4" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                Request Compute
              </button>
            </Link>
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}
