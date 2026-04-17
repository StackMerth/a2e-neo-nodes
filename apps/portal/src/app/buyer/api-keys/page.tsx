'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Key, Plus, Copy, Check, Trash2, Clock, Shield } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

interface ApiKeyItem {
  id: string
  name: string
  key: string
  permissions: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

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

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48" />
      </div>
    )
  }

  return (
    <motion.div className="space-y-6" variants={container} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          <Key size={28} style={{ color: 'var(--primary)' }} />
          API Keys
        </h1>
        <Button size="sm" onClick={() => { setShowCreate(true); setCreatedKey(null); setNewKeyName(''); setNewKeyExpiry(''); }}>
          <Plus size={16} className="mr-2" /> Create Key
        </Button>
      </motion.div>

      <motion.div variants={item}>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Use API keys for programmatic access to your compute resources. Keys authenticate as your account.
        </p>
      </motion.div>

      {/* Key List */}
      <motion.div variants={item}>
        <div className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          {keys.length === 0 ? (
            <div className="text-center py-16">
              <Key size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No API keys yet</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Create one to get started with the API</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--glass-border)', color: 'var(--text-muted)' }}>
                    <th className="text-left px-5 py-3 text-xs uppercase tracking-wider font-medium">Name</th>
                    <th className="text-left px-5 py-3 text-xs uppercase tracking-wider font-medium">Key</th>
                    <th className="text-left px-5 py-3 text-xs uppercase tracking-wider font-medium">Permissions</th>
                    <th className="text-left px-5 py-3 text-xs uppercase tracking-wider font-medium">Last Used</th>
                    <th className="text-left px-5 py-3 text-xs uppercase tracking-wider font-medium">Created</th>
                    <th className="text-right px-5 py-3 text-xs uppercase tracking-wider font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} style={{ borderBottom: '1px solid var(--glass-border)' }}>
                      <td className="px-5 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{k.name}</td>
                      <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{k.key}</td>
                      <td className="px-5 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {k.permissions.map(p => (
                            <span key={p} className="text-2xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--primary)' }}>{p}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{timeAgo(k.lastUsedAt)}</td>
                      <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(k.createdAt).toLocaleDateString()}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => handleRevoke(k.id)}
                          className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded transition-colors"
                          style={{ color: 'var(--danger)' }}
                        >
                          <Trash2 size={12} /> Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </motion.div>

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
              Permissions: compute:read, compute:write
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate} loading={creating} disabled={!newKeyName.trim()}>Create Key</Button>
            </div>
          </div>
        )}
      </Modal>
    </motion.div>
  )
}
