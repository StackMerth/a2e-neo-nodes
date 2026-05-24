'use client'

/*
 * Top navigation bar, NEXUS-OS-shape: mobile sidebar burger on small
 * screens, TokenOS_DeAI wordmark, search input, bell, theme toggle,
 * and the user-menu trigger (avatar) on the right.
 *
 * Mounted on top of every (node-runner)/* and buyer/* page via the
 * route-group layouts. The left sidebar still owns navigation; this
 * header owns identity + global actions + the mobile sidebar toggle.
 */

import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { ThemeToggle } from '@/components/theme-toggle'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'
import { GlobalSearch } from './GlobalSearch'
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator'
import { BalanceIndicator } from './BalanceIndicator'

export function TopHeader() {
  const { user } = useAuth()
  const { sidebarOpen, toggleSidebar } = useSidebar()

  const displayName = user?.email || user?.walletAddress
    ? user?.email || `${user?.walletAddress?.slice(0, 6)}...${user?.walletAddress?.slice(-4)}`
    : 'User'

  const avatarLetter = (user?.email || user?.walletAddress || 'U').charAt(0).toUpperCase()
  const roleLabel = user?.role ?? ''

  return (
    <header
      className="fixed top-0 left-0 right-0 z-30 h-16 px-3 sm:px-4 md:px-6 flex items-center gap-2 sm:gap-3 border-b border-border"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur, 20px))',
        WebkitBackdropFilter: 'blur(var(--glass-blur, 20px))',
      }}
    >
      {/* Mobile sidebar toggle (visible on small screens only). The
          sidebar's outside-click handler excludes elements carrying
          data-mobile-menu-trigger so this button can toggle without
          fighting the auto-close. */}
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

      {/* Two-tone TokenOS_DeAI wordmark. `min-w-0` + `truncate` so the
          wordmark can shrink instead of pushing the rest of the bar
          off-screen on very narrow viewports. */}
      <Link href="/dashboard" className="flex items-center min-w-0 flex-shrink">
        <span className="font-display text-lg sm:text-xl tracking-tight truncate">
          <span style={{ color: 'var(--text-primary)' }}>TokenOS</span>
          <span style={{ color: 'var(--primary)' }}>_DeAI</span>
        </span>
      </Link>

      {/* Global search (hidden on the smallest screens to keep the bar
          uncrowded). Cmd/Ctrl-K focuses the input from anywhere. */}
      <div className="hidden md:flex items-center flex-1 max-w-md md:mx-4 lg:mx-6">
        <GlobalSearch />
      </div>

      {/* Right-side cluster - generous gap so bell + toggle + avatar
          read as distinct controls, not glued together. ml-auto pushes
          to the right edge when the search is hidden at sm widths. */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
        {/* Balance pill — context-aware: buyer balance on /buyer/*
            routes, operator earnings everywhere else. Click to land
            on the corresponding detail page. Hidden on the smallest
            screens to keep the bar uncrowded. */}
        <BalanceIndicator />
        {/* Connection-status dot — auto-hides after 5s of healthy
            connection, pops back when reconnecting / offline so the
            operator knows whether real-time updates are flowing. */}
        <ConnectionStatusIndicator />
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
