'use client'

import { useEffect, useRef, useState } from 'react'
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
  const router = useRouter()
  const { logout, user } = useAuth()
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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
    <div className="relative" ref={menuRef}>
      <button
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

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full mb-2 left-0 right-0 min-w-[220px] bg-surface border border-border rounded-md shadow-lg overflow-hidden z-50"
          >
            <div className="px-4 py-3 border-b border-border-subtle">
              <p className="user-name text-sm truncate">{displayName}</p>
              <p className="user-role text-xs truncate">{user?.username ?? role}</p>
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
              label="Admin Dashboard"
              onClick={() => {
                setOpen(false)
                router.push('/')
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
      </AnimatePresence>
    </div>
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
