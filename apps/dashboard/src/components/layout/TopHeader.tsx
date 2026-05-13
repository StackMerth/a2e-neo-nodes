'use client'

/*
 * Admin TopHeader. Mirrors the portal's TopHeader layout so the two
 * surfaces feel like the same app:
 *   left   : two-tone TokenOS_DeAI wordmark + small "Admin" pill
 *   center : quick-jump search input (nav pages, will grow to records)
 *   right  : theme toggle + user-menu trigger
 *
 * The sidebar still owns navigation; this header owns identity +
 * global actions, freeing the sidebar of the broken logo tile and the
 * footer ThemeToggle / UserMenu that used to clip.
 */

import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { ThemeToggle } from '@/components/theme-toggle'
import { UserMenu } from './UserMenu'
import { AdminSearch } from './AdminSearch'

export function TopHeader() {
  const { user } = useAuth()
  const { sidebarOpen, toggleSidebar } = useSidebar()
  const displayName = user?.username || 'Admin'
  const avatarLetter = (user?.username || 'A').charAt(0).toUpperCase()
  const roleLabel = user?.role ?? 'Administrator'

  return (
    <header
      className="fixed top-0 left-0 right-0 z-30 h-16 px-4 sm:px-6 flex items-center justify-between gap-3 border-b border-border"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur, 24px))',
        WebkitBackdropFilter: 'blur(var(--glass-blur, 24px))',
      }}
    >
      {/* Mobile sidebar toggle (visible on small screens only) */}
      <button
        type="button"
        onClick={toggleSidebar}
        data-mobile-menu-trigger
        className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-md border border-border shrink-0"
        style={{ background: 'var(--bg-elevated)' }}
        aria-label="Toggle sidebar"
      >
        {sidebarOpen ? <X size={18} style={{ color: 'var(--text-primary)' }} /> : <Menu size={18} style={{ color: 'var(--text-primary)' }} />}
      </button>

      {/* Two-tone wordmark + Admin pill */}
      <Link href="/" className="flex items-center gap-2 shrink-0 min-w-0">
        <span
          className="font-display tracking-tight"
          style={{
            fontSize: '1.25rem',
            fontWeight: 900,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--text-primary)' }}>TokenOS</span>
          <span style={{ color: 'var(--primary)' }}>_DeAI</span>
        </span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded-sm shrink-0"
          style={{
            color: 'var(--primary)',
            background: 'rgba(34, 197, 94, 0.10)',
            border: '1px solid rgba(34, 197, 94, 0.30)',
          }}
        >
          Admin
        </span>
      </Link>

      {/* Quick-jump search */}
      <div className="hidden md:flex items-center flex-1 max-w-md mx-6">
        <AdminSearch />
      </div>

      {/* Right cluster - generous gap to read as distinct controls */}
      <div className="flex items-center gap-3 shrink-0">
        <ThemeToggle />
        {user && (
          <UserMenu
            collapsed
            displayName={displayName}
            avatarLetter={avatarLetter}
            role={roleLabel}
          />
        )}
      </div>
    </header>
  )
}
