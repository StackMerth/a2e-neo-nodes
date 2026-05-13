'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { LayoutDashboard, LifeBuoy, LogOut, User } from 'lucide-react'

interface UserMenuProps {
  collapsed: boolean
  displayName: string
  avatarLetter: string
  role: string
}

const SUPPORT_TELEGRAM = process.env.NEXT_PUBLIC_SUPPORT_TELEGRAM || 'https://t.me/tokenosdeai'

export function UserMenu({ collapsed, displayName, avatarLetter, role }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ bottom: number; left: number; maxHeight: number } | null>(null)
  const router = useRouter()
  const { logout, user } = useAuth()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Recompute menu position whenever it opens or the window resizes.
  // bottom-based positioning anchors the menu's bottom edge 8px above
  // the trigger's top; the menu then grows upward with whatever height
  // it needs. max-height caps it to (trigger.top - 16) so it can never
  // overflow the top of the viewport - it scrolls inside instead.
  useEffect(() => {
    if (!open) return
    const position = () => {
      const t = triggerRef.current
      if (!t) return
      const rect = t.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      setCoords({
        bottom: viewportHeight - rect.top + 8,
        left: rect.right + 8,
        maxHeight: Math.max(160, rect.top - 16),
      })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

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

  const isBuyer = user?.role === 'COMPUTE_BUYER'
  const isAdmin = user?.role === 'ADMIN'
  const dashboardLabel = isAdmin ? 'Admin Dashboard' : "Buyer's Portal"
  const dashboardHref = isBuyer ? '/buyer/dashboard' : '/dashboard'

  const roleLabel = isAdmin
    ? 'Administrator'
    : isBuyer
    ? 'Compute Buyer'
    : 'Node Runner'

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
            <span className="user-role">{roleLabel}</span>
          </div>
        )}
      </button>

      {/* Portal the menu to body so the sidebar's overflow:hidden
          does NOT clip it. Position is calculated from the trigger
          rect so it always sits just outside the sidebar to the right. */}
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
                bottom: coords.bottom,
                left: coords.left,
                minWidth: 240,
                maxHeight: coords.maxHeight,
                zIndex: 9999,
              }}
              className="bg-surface border border-border rounded-md shadow-2xl overflow-y-auto"
            >
              <div className="px-4 py-3 border-b border-border-subtle">
                <p className="user-name text-sm truncate">{displayName}</p>
                <p className="user-role text-xs truncate">{user?.email ?? roleLabel}</p>
              </div>

              <MenuItem
                icon={<User className="w-4 h-4" />}
                label="Profile"
                onClick={() => {
                  setOpen(false)
                  router.push('/settings')
                }}
              />
              <MenuItem
                icon={<LayoutDashboard className="w-4 h-4" />}
                label={dashboardLabel}
                onClick={() => {
                  setOpen(false)
                  router.push(dashboardHref)
                }}
              />
              <MenuItem
                icon={<LifeBuoy className="w-4 h-4" />}
                label="Open support ticket"
                onClick={() => {
                  setOpen(false)
                  window.open(SUPPORT_TELEGRAM, '_blank', 'noreferrer')
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
