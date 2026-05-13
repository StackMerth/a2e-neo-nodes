'use client'

/*
 * Admin quick-jump search. Lives in the TopHeader. Type and the
 * dropdown surfaces matching admin nav pages. Cmd/Ctrl-K focuses
 * the input from anywhere on the admin side.
 *
 * Scope: nav-only for now (covers every routable admin page). Future:
 * extend with record search across /v1/nodes, /v1/node-runners,
 * /v1/compute, /v1/withdrawals. Same component, just add fetchers and
 * additional result types.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, LayoutDashboard, Server, Briefcase, GitBranch, Users, Wallet,
  Rocket, Monitor, Star, TrendingUp, Globe, BarChart3, CreditCard,
  DollarSign, Receipt, FileText, ClipboardCheck, Settings,
} from 'lucide-react'

interface NavItem {
  label: string
  hint: string
  href: string
  icon: typeof Search
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',         hint: 'Network overview',                 href: '/',              icon: LayoutDashboard },
  { label: 'Nodes',             hint: 'All registered machines',          href: '/nodes',         icon: Server },
  { label: 'Jobs',              hint: 'Job log',                          href: '/jobs',          icon: Briefcase },
  { label: 'Routing',           hint: 'Routing engine + decisions',       href: '/routing',       icon: GitBranch },
  { label: 'Node Runners',      hint: 'Operator profiles',                href: '/node-runners',  icon: Users },
  { label: 'Investments',       hint: 'Operator capital',                 href: '/investments',   icon: Wallet },
  { label: 'Deployments',       hint: 'Pending + provisioned',            href: '/deployments',   icon: Rocket },
  { label: 'Compute',           hint: 'Buyer compute requests',           href: '/compute',       icon: Monitor },
  { label: 'Ratings',           hint: 'Moderation queue',                 href: '/ratings',       icon: Star },
  { label: 'Rates',             hint: 'Per-tier rate config',             href: '/rates',         icon: TrendingUp },
  { label: 'External Markets',  hint: 'Vast.ai / overflow config',        href: '/external',      icon: Globe },
  { label: 'Financial',         hint: 'Top-line P&L',                     href: '/financial',     icon: BarChart3 },
  { label: 'Payments',          hint: 'Solana settlements + payments',    href: '/payments',      icon: CreditCard },
  { label: 'Earnings',          hint: 'Operator earnings ledger',         href: '/earnings',      icon: DollarSign },
  { label: 'Costs',             hint: 'Infrastructure costs',             href: '/costs',         icon: Receipt },
  { label: 'Reports',           hint: 'Generated reports',                href: '/reports',       icon: FileText },
  { label: 'Withdrawals',       hint: 'Operator withdrawal queue',        href: '/withdrawals',   icon: Wallet },
  { label: 'Audit',             hint: 'Audit log',                        href: '/audit',         icon: ClipboardCheck },
  { label: 'Settings',          hint: 'Admin + smtp + auth',              href: '/settings',      icon: Settings },
]

export function AdminSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
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

  const results = useMemo<NavItem[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return NAV_ITEMS.slice(0, 8)
    return NAV_ITEMS
      .filter(n => n.label.toLowerCase().includes(q) || n.hint.toLowerCase().includes(q))
      .slice(0, 12)
  }, [query])

  useEffect(() => { setHighlight(0) }, [query, open])

  const onSelect = useCallback((n: NavItem) => {
    setOpen(false)
    setQuery('')
    router.push(n.href)
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
          placeholder="Search admin pages..."
          className="bg-transparent border-none outline-none text-sm w-full"
          style={{ color: 'var(--text-primary)' }}
        />
        <kbd
          className="hidden sm:inline-flex font-mono text-[10px] px-1.5 py-0.5 rounded shrink-0"
          style={{
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-muted)',
          }}
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
                No matches for &quot;{query}&quot;
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
                    <li key={r.href}>
                      <button
                        type="button"
                        onMouseEnter={() => setHighlight(idx)}
                        onClick={() => onSelect(r)}
                        className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors"
                        style={{
                          background: isActive ? 'var(--bg-card-hover)' : 'transparent',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <r.icon className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{r.label}</p>
                          <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{r.hint}</p>
                        </div>
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
