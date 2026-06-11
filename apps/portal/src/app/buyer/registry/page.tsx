'use client'

import { useState, useEffect } from 'react'
import { Container, Trash2, AlertTriangle, ShieldCheck, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface ScanSummary {
  id: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  unknownCount: number
  startedAt: string
  completedAt: string | null
}

interface RegistryImage {
  id: string
  repository: string
  tag: string
  digest: string
  sizeBytes: number
  pushedAt: string
  deletedAt: string | null
  pullBlocked: boolean
  pullBlockReason: string | null
  latestScan: ScanSummary | null
}

type RegistryImageRow = RegistryImage & Record<string, unknown>

interface QuotaSnapshot {
  userId: string
  limitBytes: number
  usedBytes: number
  remainingBytes: number
  over: boolean
  fractionUsed: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function timeAgo(d: string | null): string {
  if (!d) return '—'
  const seconds = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default function RegistryPage() {
  const { toast } = useToast()
  const [images, setImages] = useState<RegistryImage[]>([])
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [imgs, q] = await Promise.all([
        apiFetch<{ images: RegistryImage[]; nextCursor: string | null }>(
          '/v1/buyer/registry/images',
        ),
        apiFetch<QuotaSnapshot>('/v1/buyer/registry/quota'),
      ])
      setImages(imgs.images)
      setQuota(q)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load registry')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: string, repo: string, tag: string) {
    if (!confirm(`Delete ${repo}:${tag}? Existing pulls will fail. R2 storage frees on next GC sweep.`)) {
      return
    }
    setDeleting(id)
    try {
      await apiFetch(`/v1/buyer/registry/images/${id}`, { method: 'DELETE' })
      toast('success', 'Image deleted')
      void loadAll()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  const columns: DataTableColumn<RegistryImageRow>[] = [
    {
      key: 'repository',
      header: 'Image',
      render: (img) => (
        <div className="flex flex-col">
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
            {img.repository}:{img.tag}
          </span>
          <span className="text-2xs font-mono opacity-60" style={{ color: 'var(--text-secondary)' }}>
            {img.digest.slice(0, 19)}...
          </span>
        </div>
      ),
    },
    {
      key: 'sizeBytes',
      header: 'Size',
      mono: true,
      render: (img) => formatBytes(img.sizeBytes),
    },
    {
      key: 'latestScan',
      header: 'Scan',
      render: (img) => {
        if (!img.latestScan) {
          return <span className="text-2xs opacity-60">No scan yet</span>
        }
        const s = img.latestScan
        if (s.status === 'PENDING' || s.status === 'RUNNING') {
          return (
            <span className="text-2xs inline-flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
              <Loader2 size={10} className="animate-spin" /> {s.status.toLowerCase()}
            </span>
          )
        }
        if (s.status === 'FAILED') {
          return <span className="text-2xs" style={{ color: 'var(--warn)' }}>scan failed</span>
        }
        // COMPLETED
        if (s.criticalCount > 0) {
          return (
            <span className="text-2xs inline-flex items-center gap-1" style={{ color: 'var(--danger)' }}>
              <AlertTriangle size={10} /> {s.criticalCount} critical
            </span>
          )
        }
        if (s.highCount > 0) {
          return (
            <span className="text-2xs" style={{ color: 'var(--warn)' }}>
              {s.highCount} high
            </span>
          )
        }
        return (
          <span className="text-2xs inline-flex items-center gap-1" style={{ color: 'var(--primary)' }}>
            <ShieldCheck size={10} /> clean
          </span>
        )
      },
    },
    {
      key: 'pushedAt',
      header: 'Pushed',
      mono: true,
      render: (img) => timeAgo(img.pushedAt),
    },
    {
      key: 'pullBlocked',
      header: 'Status',
      render: (img) => {
        if (img.pullBlocked) {
          return (
            <span
              className="text-2xs px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--danger)' }}
              title={img.pullBlockReason ?? ''}
            >
              blocked
            </span>
          )
        }
        return (
          <span className="text-2xs px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--primary)' }}>
            active
          </span>
        )
      },
    },
    {
      key: 'id',
      header: '',
      align: 'right',
      render: (img) => (
        <button
          onClick={() => handleDelete(img.id, img.repository, img.tag)}
          disabled={deleting === img.id}
          className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded transition-colors hover:bg-surface-hover disabled:opacity-50"
          style={{ color: 'var(--danger)' }}
        >
          <Trash2 size={12} /> Delete
        </button>
      ),
    },
  ]

  return (
    <DashboardShell
      title="Container Registry"
      subtitle="Private Docker images for your workloads"
    >
      <div className="lg:col-span-3 space-y-4">
        {/* Quota usage card */}
        {quota && (
          <div
            className="rounded-lg p-4"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Storage usage
              </span>
              <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)}
              </span>
            </div>
            <div
              className="h-2 rounded-full overflow-hidden"
              style={{ background: 'var(--bg-secondary)' }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, quota.fractionUsed * 100)}%`,
                  background: quota.over
                    ? 'var(--danger)'
                    : quota.fractionUsed > 0.8
                      ? 'var(--warn)'
                      : 'var(--primary)',
                }}
              />
            </div>
            {quota.over && (
              <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
                Over quota. New pushes will be blocked until you delete images.
              </p>
            )}
          </div>
        )}

        <DataTableCard<RegistryImageRow>
          title="Pushed images"
          icon={Container}
          columns={columns}
          rows={(images ?? []) as RegistryImageRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Container}
              title="No images yet"
              description={
                'Push your first image with: docker login a2e-registry.onrender.com -u <userId> -p <apiKey>'
              }
            />
          }
        />
      </div>
    </DashboardShell>
  )
}
