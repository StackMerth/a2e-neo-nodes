'use client'

/*
 * Top navigation bar, NEXUS-OS-shape: TokenOS_DeAI wordmark on the
 * left, a search input in the middle, then notification bell, theme
 * toggle, and the user-menu trigger (avatar) on the right.
 *
 * Mounted on top of every (node-runner)/* and buyer/* page via the
 * route-group layouts. The existing left sidebar still owns
 * navigation; this header owns identity + global actions.
 */

import Link from 'next/link'
import { Search, Hexagon } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { ThemeToggle } from '@/components/theme-toggle'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'

export function TopHeader() {
  const { user } = useAuth()

  const displayName = user?.email || user?.walletAddress
    ? user?.email || `${user?.walletAddress?.slice(0, 6)}...${user?.walletAddress?.slice(-4)}`
    : 'User'

  const avatarLetter = (user?.email || user?.walletAddress || 'U').charAt(0).toUpperCase()
  const roleLabel = user?.role ?? ''

  return (
    <header
      className="fixed top-0 left-0 right-0 z-30 h-16 px-4 sm:px-6 flex items-center justify-between border-b border-border"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur, 20px))',
        WebkitBackdropFilter: 'blur(var(--glass-blur, 20px))',
      }}
    >
      {/* Logo: hexagon + two-tone TokenOS_DeAI wordmark */}
      <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
        <Hexagon className="w-7 h-7" style={{ color: 'var(--primary)' }} strokeWidth={2.5} />
        <span className="font-display text-xl tracking-tight hidden sm:inline-flex">
          <span style={{ color: 'var(--text-primary)' }}>TokenOS</span>
          <span style={{ color: 'var(--primary)' }}>_DeAI</span>
        </span>
      </Link>

      {/* Search (hidden on the smallest screens to keep the bar uncrowded) */}
      <div className="hidden md:flex items-center flex-1 max-w-md mx-6">
        <div
          className="flex items-center w-full gap-2 px-4 h-10 rounded-full border border-border"
          style={{ background: 'var(--bg-elevated)' }}
        >
          <Search className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search..."
            className="bg-transparent border-none outline-none text-sm w-full"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      {/* Right-side cluster */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <NotificationBell collapsed={true} />
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
