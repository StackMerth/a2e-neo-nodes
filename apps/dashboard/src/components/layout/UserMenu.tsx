'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { LayoutDashboard, LogOut, Settings as SettingsIcon } from 'lucide-react'

interface UserMenuProps {
  collapsed: boolean
  displayName: string
  avatarLetter: string
  role: string
}

export function UserMenu({ collapsed, displayName, avatarLetter, role }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  // Smart-positioned dropdown, portaled to body so the sidebar's
  // overflow:hidden does NOT clip it. opens upward when the trigger
  // is near the bottom (sidebar footer here), downward when at top.
  const [coords, setCoords] = useState<{
    direction: 'down' | 'up'
    anchor: number
    left: number
    maxHeight: number
  } | null>(null)
  const router = useRouter()
  const { logout, user } = useAuth()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const position = () => {
      const t = triggerRef.current
      if (!t) return
      const rect = t.getBoundingClientRect()
      const vh = window.innerHeight
      const vw = window.innerWidth
      const spaceBelow = vh - rect.bottom
      const spaceAbove = rect.top
      const direction: 'down' | 'up' = spaceBelow > spaceAbove ? 'down' : 'up'
      // Anchor to the right edge of the trigger when in the collapsed
      // sidebar (so the menu flies out to the right). When expanded
      // (full sidebar footer), align with the left edge instead.
      const left = collapsed
        ? Math.min(rect.right + 8, vw - 260)
        : Math.max(8, rect.left)
      setCoords({
        direction,
        anchor: direction === 'down' ? rect.bottom + 8 : vh - rect.top + 8,
        left,
        maxHeight: Math.max(160, (direction === 'down' ? spaceBelow : spaceAbove) - 16),
      })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, collapsed])

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node
      if (
        menuRef.current && !menuRef.current.contains(t)
        && triggerRef.current && !triggerRef.current.contains(t)
      ) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleLogout = async () => {
    setOpen(false)
    await logout()
    router.push('/login')
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-surface-hover transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <motion.div
          className="user-avatar"
          whileHover={{ scale: 1.05 }}
          style={{ flexShrink: 0 }}
        >
          {avatarLetter}
        </motion.div>
        {!collapsed && (
          <div className="flex flex-col text-left flex-1 min-w-0">
            <span className="user-name truncate">{displayName}</span>
            <span className="user-role">{role || 'Administrator'}</span>
          </div>
        )}
      </button>

      {typeof window !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && coords && (
            <motion.div
              ref={menuRef}
              role="menu"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              style={{
                position: 'fixed',
                ...(coords.direction === 'down'
                  ? { top: coords.anchor }
                  : { bottom: coords.anchor }),
                left: coords.left,
                minWidth: 240,
                maxHeight: coords.maxHeight,
                zIndex: 9999,
              }}
              className="bg-surface border border-border rounded-md shadow-2xl overflow-y-auto"
            >
              <div className="px-4 py-3 border-b border-border-subtle">
                <p className="user-name text-sm truncate">{displayName}</p>
                <p className="user-role text-xs truncate">{user?.username ?? role}</p>
              </div>

              <MenuItem
                icon={<SettingsIcon className="w-4 h-4" />}
                label="Settings"
                onClick={() => {
                  setOpen(false)
                  router.push('/settings')
                }}
              />
              <MenuItem
                icon={<LayoutDashboard className="w-4 h-4" />}
                label="Admin Dashboard"
                onClick={() => {
                  setOpen(false)
                  router.push('/')
                }}
              />
              <div className="border-t border-border-subtle">
                <MenuItem
                  icon={<LogOut className="w-4 h-4" />}
                  label="Sign out"
                  tone="danger"
                  onClick={handleLogout}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  tone = 'default',
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors hover:bg-surface-hover ${
        tone === 'danger' ? 'text-error' : 'text-text-primary'
      }`}
    >
      <span className={tone === 'danger' ? 'text-error' : 'text-text-secondary'}>{icon}</span>
      <span>{label}</span>
    </button>
  )
}
