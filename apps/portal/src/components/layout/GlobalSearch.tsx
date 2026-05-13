'use client'

/*
 * GlobalSearch lives in the TopHeader. Click or focus the input,
 * type, and a dropdown surfaces:
 *   - matching navigation pages (Dashboard, Nodes, Earnings, etc.)
 *   - matching nodes (by ID prefix, GPU tier, or wallet)
 *   - matching deployments (by ID prefix or tier)
 *   - matching compute requests / rentals
 *
 * Keyboard:
 *   - Esc closes the dropdown
 *   - Up/Down moves the highlight
 *   - Enter navigates to the highlighted entry
 *   - Cmd/Ctrl-K focuses the input from anywhere
 *
 * Nav matches resolve client-side from a small static list. Item
 * matches (nodes, deployments, requests) lazy-fetch from the existing
 * portal APIs once the user has typed at least 2 characters; results
 * cached for the rest of the session.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search,
  LayoutDashboard, Server, Package, DollarSign, Wallet as WalletIcon,
  ArrowDownToLine, Zap, Users, Settings, BookOpen, CreditCard, Key,
  Rocket, List, Plus,
} from 'lucide-react'
import { nodeRunner, buyer } from '@/lib/api'

interface NavItem {
  type: 'nav'
  label: string
  hint: string
  href: string
  icon: typeof Search
}

interface NodeItem {
  type: 'node'
  id: string
  label: string
  gpuTier: string
  status: string
  walletAddress: string
}

interface DeploymentItem {
  type: 'deployment'
  id: string
  gpuTier: string
  nodeCount: number
  status: string
  amount: number
}

interface RentalItem {
  type: 'rental'
  id: string
  gpuTier: string
  status: string
}

type SearchResult = NavItem | NodeItem | DeploymentItem | RentalItem

const NAV_ITEMS: NavItem[] = [
  { type: 'nav', label: 'Dashboard',         hint: 'Operator overview',        href: '/dashboard',    icon: LayoutDashboard },
  { type: 'nav', label: 'Deploy',            hint: 'Provision a new node',     href: '/deploy',       icon: Rocket },
  { type: 'nav', label: 'Nodes',             hint: 'Your registered machines', href: '/nodes',        icon: Server },
  { type: 'nav', label: 'Deployments',       hint: 'Past + active deployments', href: '/deployments', icon: Package },
  { type: 'nav', label: 'Earnings',          hint: 'Daily yield by node',      href: '/earnings',     icon: DollarSign },
  { type: 'nav', label: 'Earnings history',  hint: 'Trailing earnings log',    href: '/earnings/history', icon: DollarSign },
  { type: 'nav', label: 'Payouts',           hint: 'Settled payouts',          href: '/payouts',      icon: WalletIcon },
  { type: 'nav', label: 'Payout settings',   hint: 'Frequency + threshold',    href: '/payouts/settings', icon: WalletIcon },
  { type: 'nav', label: 'Withdrawals',       hint: 'Withdraw to wallet',       href: '/withdrawals',  icon: ArrowDownToLine },
  { type: 'nav', label: 'Jobs',              hint: 'Per-job log',              href: '/jobs',         icon: Zap },
  { type: 'nav', label: 'Referrals',         hint: 'Invite operators',         href: '/referral',     icon: Users },
  { type: 'nav', label: 'Settings',          hint: 'Profile + identity',       href: '/settings',     icon: Settings },
  { type: 'nav', label: 'Buyer dashboard',   hint: 'Switch to buyer side',     href: '/buyer/dashboard', icon: LayoutDashboard },
  { type: 'nav', label: 'Request compute',   hint: 'Rent GPU capacity',        href: '/buyer/request', icon: Plus },
  { type: 'nav', label: 'My requests',       hint: 'Your rentals',             href: '/buyer/requests', icon: List },
  { type: 'nav', label: 'Active compute',    hint: 'Live SSH sessions',        href: '/buyer/active',  icon: Server },
  { type: 'nav', label: 'Billing',           hint: 'Invoices + balance',       href: '/buyer/billing', icon: CreditCard },
  { type: 'nav', label: 'API keys',          hint: 'For programmatic access',  href: '/buyer/api-keys', icon: Key },
  { type: 'nav', label: 'API docs',          hint: 'How to call the API',     href: '/buyer/docs',    icon: BookOpen },
]

interface NodeApiItem {
  id: string
  gpuTier: string
  status: string
  walletAddress: string
  customGpuModel?: string | null
}
interface DeploymentApiItem {
  id: string
  gpuTier: string
  nodeCount: number
  status: string
  amount: number
}
interface RentalApiItem {
  id: string
  gpuTier: string
  status: string
}

export function GlobalSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [nodes, setNodes] = useState<NodeApiItem[] | null>(null)
  const [deployments, setDeployments] = useState<DeploymentApiItem[] | null>(null)
  const [rentals, setRentals] = useState<RentalApiItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Cmd/Ctrl-K focuses the input from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node | null
      if (!t) return
      if (wrapRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Lazy-load item data once the user has typed >=2 chars.
  useEffect(() => {
    if (query.length < 2) return
    if (nodes && deployments && rentals) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      nodes ?? nodeRunner.nodes().catch(() => ({ nodes: [] })),
      deployments ?? nodeRunner.deployments().catch(() => ({ deployments: [] })),
      rentals ?? buyer.requests({ limit: '100' }).catch(() => ({ requests: [] })),
    ]).then(([nRes, dRes, rRes]) => {
      if (cancelled) return
      const ns = (nRes as { nodes?: NodeApiItem[] }).nodes ?? []
      const ds = (dRes as { deployments?: DeploymentApiItem[] }).deployments ?? []
      const rs = (rRes as { requests?: RentalApiItem[] }).requests ?? []
      if (!nodes) setNodes(ns)
      if (!deployments) setDeployments(ds)
      if (!rentals) setRentals(rs)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [query, nodes, deployments, rentals])

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // Empty query: show a useful default (a slice of nav pages).
      return NAV_ITEMS.slice(0, 8)
    }
    const out: SearchResult[] = []

    for (const n of NAV_ITEMS) {
      if (n.label.toLowerCase().includes(q) || n.hint.toLowerCase().includes(q)) {
        out.push(n)
      }
    }

    if (nodes) {
      for (const n of nodes) {
        const hit = n.id.toLowerCase().includes(q)
          || n.gpuTier.toLowerCase().includes(q)
          || n.walletAddress.toLowerCase().includes(q)
          || (n.customGpuModel?.toLowerCase().includes(q) ?? false)
        if (hit) {
          out.push({
            type: 'node', id: n.id,
            label: n.customGpuModel || `${n.gpuTier} - ${n.id.slice(0, 6)}`,
            gpuTier: n.gpuTier, status: n.status,
            walletAddress: n.walletAddress,
          })
        }
      }
    }

    if (deployments) {
      for (const d of deployments) {
        const hit = d.id.toLowerCase().includes(q) || d.gpuTier.toLowerCase().includes(q)
        if (hit) {
          out.push({
            type: 'deployment', id: d.id,
            gpuTier: d.gpuTier, nodeCount: d.nodeCount,
            status: d.status, amount: d.amount,
          })
        }
      }
    }

    if (rentals) {
      for (const r of rentals) {
        const hit = r.id.toLowerCase().includes(q) || r.gpuTier.toLowerCase().includes(q)
        if (hit) {
          out.push({
            type: 'rental', id: r.id,
            gpuTier: r.gpuTier, status: r.status,
          })
        }
      }
    }

    return out.slice(0, 12)
  }, [query, nodes, deployments, rentals])

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  const onSelect = useCallback((r: SearchResult) => {
    setOpen(false)
    setQuery('')
    switch (r.type) {
      case 'nav':        router.push(r.href); break
      case 'node':       router.push(`/nodes/${r.id}`); break
      case 'deployment': router.push(`/deployments/${r.id}`); break
      case 'rental':     router.push(`/buyer/requests/${r.id}`); break
    }
  }, [router])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, results.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const sel = results[highlight]
      if (sel) onSelect(sel)
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <div
        className="flex items-center w-full gap-2 px-4 h-10 rounded-full border border-border focus-within:border-primary transition-colors"
        style={{ background: 'var(--bg-elevated)' }}
      >
        <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search pages, nodes, deployments..."
          className="bg-transparent border-none outline-none text-sm w-full"
          style={{ color: 'var(--text-primary)' }}
        />
        <kbd
          className="hidden sm:inline-flex font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0"
          style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}
        >
          {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}+K
        </kbd>
      </div>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full mt-2 rounded-xl overflow-hidden z-40 max-h-[60vh] overflow-y-auto"
          style={{
            background: 'var(--bg-card)',
            backdropFilter: 'blur(var(--glass-blur, 24px))',
            WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
            border: '1px solid var(--glass-border)',
            boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0, 0, 0, 0.45))',
          }}
        >
          {results.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {loading ? 'Searching...' : `No matches for "${query}"`}
              </p>
            </div>
          ) : (
            <>
              {!query.trim() && (
                <p
                  className="px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em]"
                  style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}
                >
                  Quick jump
                </p>
              )}
              <ul>
                {results.map((r, idx) => {
                  const isActive = idx === highlight
                  return (
                    <li key={`${r.type}-${'id' in r ? r.id : (r as NavItem).href}`}>
                      <button
                        type="button"
                        onMouseEnter={() => setHighlight(idx)}
                        onClick={() => onSelect(r)}
                        className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors"
                        style={{
                          background: isActive ? 'var(--surface-hover)' : 'transparent',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <ResultIcon r={r} />
                        <ResultBody r={r} />
                        {r.type !== 'nav' && (
                          <span
                            className="font-mono text-[10px] px-2 py-0.5 rounded-sm shrink-0"
                            style={{
                              color: 'var(--text-muted)',
                              background: 'var(--surface-elevated)',
                              border: '1px solid var(--border-color)',
                            }}
                          >
                            {r.type}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ResultIcon({ r }: { r: SearchResult }) {
  if (r.type === 'nav') {
    return <r.icon className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
  }
  if (r.type === 'node') {
    return <Server className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
  }
  if (r.type === 'deployment') {
    return <Package className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
  }
  return <Zap className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
}

function ResultBody({ r }: { r: SearchResult }) {
  if (r.type === 'nav') {
    return (
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{r.label}</p>
        <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{r.hint}</p>
      </div>
    )
  }
  if (r.type === 'node') {
    return (
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
          {r.label} <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{r.status}</span>
        </p>
        <p className="font-mono text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
          {r.walletAddress.slice(0, 6)}...{r.walletAddress.slice(-4)}
        </p>
      </div>
    )
  }
  if (r.type === 'deployment') {
    return (
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
          {r.gpuTier} - {r.nodeCount} node{r.nodeCount === 1 ? '' : 's'}
        </p>
        <p className="font-mono text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
          {r.status} - ${r.amount.toLocaleString()}
        </p>
      </div>
    )
  }
  return (
    <div className="flex-1 min-w-0">
      <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
        Rental {r.id.slice(0, 8)}
      </p>
      <p className="font-mono text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
        {r.gpuTier} - {r.status}
      </p>
    </div>
  )
}
