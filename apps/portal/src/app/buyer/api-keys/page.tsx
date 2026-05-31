'use client'

import { useState, useEffect } from 'react'
import { Key, Plus, Copy, Check, Trash2, Shield } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface ApiKeyItem {
  id: string
  name: string
  key: string
  permissions: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

type ApiKeyRow = ApiKeyItem & Record<string, unknown>

export default function ApiKeysPage() {
  const { toast } = useToast()
  const [keys, setKeys] = useState<ApiKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyExpiry, setNewKeyExpiry] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { loadKeys() }, [])

  async function loadKeys() {
    try {
      const data = await apiFetch<{ keys: ApiKeyItem[] }>('/v1/buyer/api-keys')
      setKeys(data.keys)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  async function handleCreate() {
    if (!newKeyName.trim()) return
    setCreating(true)
    try {
      const data = await apiFetch<{ id: string; key: string; name: string }>('/v1/buyer/api-keys', {
        method: 'POST',
        body: {
          name: newKeyName.trim(),
          expiresInDays: newKeyExpiry ? Number(newKeyExpiry) : undefined,
        },
      })
      setCreatedKey(data.key)
      toast('success', 'API key created')
      loadKeys()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed')
    }
    finally { setCreating(false) }
  }

  async function handleRevoke(id: string) {
    try {
      await apiFetch(`/v1/buyer/api-keys/${id}`, { method: 'DELETE' })
      toast('success', 'API key revoked')
      loadKeys()
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed')
    }
  }

  async function copyKey() {
    if (!createdKey) return
    await navigator.clipboard.writeText(createdKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const timeAgo = (d: string | null) => {
    if (!d) return 'Never'
    const diff = Date.now() - new Date(d).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const columns: Array<DataTableColumn<ApiKeyRow>> = [
    {
      key: 'name',
      header: 'Name',
      render: (k) => (
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{k.name}</span>
      ),
    },
    {
      key: 'key',
      header: 'Key',
      mono: true,
      render: (k) => k.key,
    },
    {
      key: 'permissions',
      header: 'Permissions',
      render: (k) => (
        <div className="flex gap-1 flex-wrap">
          {k.permissions.map((p) => (
            <span
              key={p}
              className="text-2xs px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--primary)' }}
            >
              {p}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: 'lastUsedAt',
      header: 'Last Used',
      mono: true,
      render: (k) => timeAgo(k.lastUsedAt),
    },
    {
      key: 'createdAt',
      header: 'Created',
      mono: true,
      render: (k) => new Date(k.createdAt).toLocaleDateString(),
    },
    {
      key: 'id',
      header: '',
      align: 'right',
      render: (k) => (
        <button
          onClick={() => handleRevoke(k.id)}
          className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded transition-colors hover:bg-surface-hover"
          style={{ color: 'var(--danger)' }}
        >
          <Trash2 size={12} /> Revoke
        </button>
      ),
    },
  ]

  const createButton = (
    <Button
      size="sm"
      onClick={() => { setShowCreate(true); setCreatedKey(null); setNewKeyName(''); setNewKeyExpiry('') }}
    >
      <Plus size={14} className="mr-1" /> Create Key
    </Button>
  )

  return (
    <DashboardShell
      title="API Keys"
      subtitle="Programmatic access to your compute resources"
    >
      <div className="lg:col-span-3">
        <DataTableCard<ApiKeyRow>
          title="API Keys"
          icon={Key}
          actions={createButton}
          columns={columns}
          rows={(keys ?? []) as ApiKeyRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Key}
              title="No API keys yet"
              description="Create one to get started with the API. Keys authenticate as your account."
              action={createButton}
            />
          }
        />
      </div>

      {/* Create Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={createdKey ? 'API Key Created' : 'Create API Key'}>
        {createdKey ? (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Copy this key now. It will not be shown again.
            </p>
            <div className="flex items-center gap-2 p-3 rounded-lg font-mono text-xs break-all" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
              {createdKey}
              <button onClick={copyKey} className="shrink-0 p-1.5 rounded transition-colors hover:opacity-80" style={{ color: 'var(--primary)' }}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setShowCreate(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Input label="Key Name" placeholder="e.g. Production API" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} />
            <Input label="Expires In (days, optional)" type="number" placeholder="Leave empty for no expiry" value={newKeyExpiry} onChange={e => setNewKeyExpiry(e.target.value)} />
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Shield size={12} />
              Permissions: compute:read, compute:write, inference:write
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate} loading={creating} disabled={!newKeyName.trim()}>Create Key</Button>
            </div>
          </div>
        )}
      </Modal>
    </DashboardShell>
  )
}
