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
import { useAuth } from '@/hooks/useAuth'
import { ThemeToggle } from '@/components/theme-toggle'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'
import { GlobalSearch } from './GlobalSearch'

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
      {/* Two-tone TokenOS_DeAI wordmark only - no icon. */}
      <Link href="/dashboard" className="flex items-center shrink-0">
        <span className="font-display text-xl tracking-tight">
          <span style={{ color: 'var(--text-primary)' }}>TokenOS</span>
          <span style={{ color: 'var(--primary)' }}>_DeAI</span>
        </span>
      </Link>

      {/* Global search (hidden on the smallest screens to keep the bar
          uncrowded). Cmd/Ctrl-K focuses the input from anywhere. */}
      <div className="hidden md:flex items-center flex-1 max-w-md mx-6">
        <GlobalSearch />
      </div>

      {/* Right-side cluster - generous gap so bell + toggle + avatar
          read as distinct controls, not glued together. */}
      <div className="flex items-center gap-3 shrink-0">
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
