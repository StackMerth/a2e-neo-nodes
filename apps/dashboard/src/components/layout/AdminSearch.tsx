'use client'

/*
 * Admin Cmd-K command palette. Mounted in the TopHeader. Type to
 * filter; pressing Enter on a:
 *   - NAV result navigates to the page
 *   - ACTION result runs the action's exec() against the admin API
 *     (e.g. "Approve next pending compute request"), toasts the
 *     result, then navigates if the action returned a route.
 *
 * Cmd/Ctrl-K focuses the input from anywhere on the admin side.
 *
 * The command registry lives in ./commands.ts so new commands can be
 * added without touching this file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import {
  ALL_COMMANDS, NAV_COMMANDS, ACTION_COMMANDS,
  type Command, type CommandContext,
} from './commands'

interface GroupedResults {
  pages: Command[]
  actions: Command[]
  flat: Command[]
}

export function AdminSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [running, setRunning] = useState(false)
  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null)
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

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  const results = useMemo<GroupedResults>(() => {
    const q = query.trim().toLowerCase()
    const filter = (c: Command) =>
      !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)

    if (!q) {
      // Empty query: surface a default mix - top nav + all actions.
      const pages = NAV_COMMANDS.slice(0, 6)
      const actions = ACTION_COMMANDS
      return { pages, actions, flat: [...pages, ...actions] }
    }
    const pages = NAV_COMMANDS.filter(filter).slice(0, 8)
    const actions = ACTION_COMMANDS.filter(filter).slice(0, 6)
    return { pages, actions, flat: [...pages, ...actions] }
  }, [query])

  useEffect(() => { setHighlight(0) }, [query, open])

  const ctx: CommandContext = useMemo(() => ({
    push: (href: string) => router.push(href),
    toast: (kind, message) => setToast({ kind, message }),
  }), [router])

  const onSelect = useCallback(async (c: Command) => {
    if (c.kind === 'nav') {
      setOpen(false)
      setQuery('')
      router.push(c.href)
      return
    }
    // Action: run it. Keep the palette open while running so the user
    // sees the running state; close after the toast surfaces.
    setRunning(true)
    try {
      await c.exec(ctx)
    } finally {
      setRunning(false)
      setOpen(false)
      setQuery('')
    }
  }, [router, ctx])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, results.flat.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const sel = results.flat[highlight]
      if (sel && !running) void onSelect(sel)
    }
  }

  // Compute the absolute index of each rendered command so the keyboard
  // highlight maps correctly across the two grouped sections.
  let cursor = 0

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
          placeholder="Search pages, run actions..."
          className="bg-transparent border-none outline-none text-sm w-full"
          style={{ color: 'var(--text-primary)' }}
          disabled={running}
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
          {results.flat.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                No matches for &quot;{query}&quot;
              </p>
            </div>
          ) : (
            <>
              {results.pages.length > 0 && (
                <Section title="Pages">
                  {results.pages.map((c) => {
                    const idx = cursor++
                    return (
                      <Row
                        key={c.id}
                        cmd={c}
                        active={idx === highlight}
                        onHover={() => setHighlight(idx)}
                        onClick={() => onSelect(c)}
                      />
                    )
                  })}
                </Section>
              )}
              {results.actions.length > 0 && (
                <Section title="Actions">
                  {results.actions.map((c) => {
                    const idx = cursor++
                    return (
                      <Row
                        key={c.id}
                        cmd={c}
                        active={idx === highlight}
                        onHover={() => setHighlight(idx)}
                        onClick={() => onSelect(c)}
                        running={running && idx === highlight}
                      />
                    )
                  })}
                </Section>
              )}
            </>
          )}
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="fixed top-20 right-6 z-50 max-w-sm rounded-md px-4 py-3 shadow-lg"
          style={{
            background: 'var(--bg-card)',
            border: `1px solid ${
              toast.kind === 'success' ? 'rgba(34,197,94,0.45)' :
              toast.kind === 'error' ? 'rgba(239,68,68,0.45)' :
              'rgba(255,255,255,0.15)'
            }`,
            color: 'var(--text-primary)',
            boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.45))',
          }}
        >
          <p className="text-sm">{toast.message}</p>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p
        className="px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em]"
        style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}
      >
        {title}
      </p>
      <ul>{children}</ul>
    </div>
  )
}

function Row({
  cmd, active, onHover, onClick, running,
}: {
  cmd: Command
  active: boolean
  onHover: () => void
  onClick: () => void
  running?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        onMouseEnter={onHover}
        onClick={onClick}
        disabled={running}
        className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors disabled:opacity-60"
        style={{
          background: active ? 'var(--bg-card-hover)' : 'transparent',
          color: 'var(--text-primary)',
        }}
      >
        <cmd.icon className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {cmd.label}
          </p>
          <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
            {cmd.hint}
          </p>
        </div>
        {cmd.kind === 'action' && (
          <span
            className="font-mono text-[10px] px-2 py-0.5 rounded-sm shrink-0"
            style={{
              color: 'var(--primary)',
              background: 'rgba(34,197,94,0.10)',
              border: '1px solid rgba(34,197,94,0.30)',
            }}
          >
            {running ? '...' : 'Action'}
          </span>
        )}
      </button>
    </li>
  )
}
