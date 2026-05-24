'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter, usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { LayoutDashboard, LifeBuoy, LogOut, User, ArrowLeftRight } from 'lucide-react'

interface UserMenuProps {
  collapsed: boolean
  displayName: string
  avatarLetter: string
  role: string
}

const SUPPORT_TELEGRAM = process.env.NEXT_PUBLIC_SUPPORT_TELEGRAM || 'https://t.me/tokenosdeai'

export function UserMenu({ collapsed, displayName, avatarLetter, role }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  // Smart-positioned: opens downward when the trigger is near the top
  // (e.g. in the TopHeader) and upward when the trigger is near the
  // bottom (e.g. legacy sidebar footer). right-anchored to the trigger
  // so the menu does not blow out of the viewport on small screens.
  const [coords, setCoords] = useState<{
    direction: 'down' | 'up'
    anchor: number
    right: number
    maxHeight: number
  } | null>(null)
  const router = useRouter()
  const pathname = usePathname()
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
      setCoords({
        direction,
        anchor: direction === 'down' ? rect.bottom + 8 : vh - rect.top + 8,
        right: Math.max(8, vw - rect.right),
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

  const isAdmin = user?.role === 'ADMIN' || !!user?.isAdmin
  // Use the dual-role flags so users with both roles can switch; the
  // old `role === 'COMPUTE_BUYER'` check missed everyone who signed up
  // as a node-runner and later opted into buyer too (and vice versa).
  const hasBuyerRole = !!user?.isBuyer || user?.role === 'COMPUTE_BUYER' || user?.role === 'CUSTOMER'
  const hasNodeRunnerRole = !!user?.isNodeRunner || user?.role === 'NODE_RUNNER'

  // Context-aware "switch portal" link: the label and destination
  // flip based on WHICH side the user is currently looking at. If
  // they are already on /buyer/* show a link to the operator side,
  // and vice versa. Hidden entirely for single-role users (no
  // opposite side to switch to).
  const onBuyerSide = pathname?.startsWith('/buyer') ?? false
  const switchLabel = onBuyerSide ? "Node Runner's Portal" : "Buyer's Portal"
  const switchHref = onBuyerSide ? '/dashboard' : '/buyer/dashboard'
  const canSwitch = hasBuyerRole && hasNodeRunnerRole

  const roleLabel = isAdmin
    ? 'Administrator'
    : hasBuyerRole && hasNodeRunnerRole
    ? 'Buyer + Node Runner'
    : hasBuyerRole
    ? 'Compute Buyer'
    : 'Node Runner'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        // In collapsed mode (TopHeader), lock to 36x36 to match the
        // bell + theme toggle exactly. In expanded mode (legacy
        // sidebar footer), stretch full width with name + role.
        style={collapsed ? { width: 36, height: 36, flex: '0 0 36px' } : undefined}
        className={
          collapsed
            ? 'inline-flex items-center justify-center rounded-md border border-border bg-surface-elevated hover:bg-surface-hover transition-colors'
            : 'w-full flex items-center gap-3 p-2 rounded-md hover:bg-surface-hover transition-colors'
        }
      >
        {collapsed ? (
          <span
            className="inline-flex items-center justify-center w-7 h-7 rounded font-bold text-xs"
            style={{ background: 'var(--primary)', color: '#ffffff' }}
          >
            {avatarLetter}
          </span>
        ) : (
          <>
            <motion.div
              className="user-avatar"
              whileHover={{ scale: 1.05 }}
              style={{ flexShrink: 0 }}
            >
              {avatarLetter}
            </motion.div>
            <div className="flex flex-col text-left flex-1 min-w-0">
              <span className="user-name truncate">{displayName}</span>
              <span className="user-role">{roleLabel}</span>
            </div>
          </>
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
                ...(coords.direction === 'down'
                  ? { top: coords.anchor }
                  : { bottom: coords.anchor }),
                right: coords.right,
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
              {isAdmin && (
                <MenuItem
                  icon={<LayoutDashboard className="w-4 h-4" />}
                  label="Admin Dashboard"
                  onClick={() => {
                    setOpen(false)
                    router.push('/dashboard')
                  }}
                />
              )}
              {canSwitch && (
                <MenuItem
                  icon={<ArrowLeftRight className="w-4 h-4" />}
                  label={`Switch to ${switchLabel}`}
                  onClick={() => {
                    setOpen(false)
                    router.push(switchHref)
                  }}
                />
              )}
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
