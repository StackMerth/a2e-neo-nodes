'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { NotificationBell } from './NotificationBell'

const navLinks = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/nodes', label: 'Nodes' },
  { href: '/earnings', label: 'Earnings' },
  { href: '/jobs', label: 'Jobs' },
]

export function Navbar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <header className="sticky top-0 z-40 glass-strong border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href={user ? '/dashboard' : '/login'} className="flex items-center gap-2">
            <span className="text-xl font-bold gradient-text">A²E</span>
            <span className="text-sm text-text-muted hidden sm:inline">Portal</span>
          </Link>

          {/* Desktop Nav */}
          {user && (
            <nav className="hidden md:flex items-center gap-1">
              {navLinks.map(link => {
                const active = pathname.startsWith(link.href)
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}
            </nav>
          )}

          {/* Right side */}
          <div className="flex items-center gap-3">
            {user && (
              <>
                <NotificationBell />
                <div className="hidden sm:flex items-center gap-2 text-sm text-text-secondary">
                  {user.walletAddress
                    ? `${user.walletAddress.slice(0, 4)}...${user.walletAddress.slice(-4)}`
                    : user.email}
                </div>
                <button
                  onClick={logout}
                  className="text-sm text-text-muted hover:text-error transition-colors"
                >
                  Logout
                </button>
              </>
            )}

            {/* Mobile hamburger */}
            {user && (
              <button
                className="md:hidden p-2 text-text-secondary hover:text-text-primary"
                onClick={() => setMobileOpen(!mobileOpen)}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {mobileOpen ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  )}
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Mobile menu */}
        {mobileOpen && user && (
          <nav className="md:hidden pb-4 border-t border-border mt-2 pt-3 space-y-1">
            {navLinks.map(link => {
              const active = pathname.startsWith(link.href)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={`block px-3 py-2 rounded-lg text-sm font-medium ${
                    active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {link.label}
                </Link>
              )
            })}
            <Link
              href="/payouts"
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Payouts
            </Link>
            <Link
              href="/settings"
              onClick={() => setMobileOpen(false)}
              className="block px-3 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Settings
            </Link>
          </nav>
        )}
      </div>
    </header>
  )
}
