'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { Sun, Moon } from 'lucide-react'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = mounted ? resolvedTheme === 'dark' : true

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      // Match the bell + avatar visual: 36x36 round-cornered surface
      // with a visible border + elevated background so it reads as a
      // tappable button on the frosted header.
      className={`inline-flex items-center justify-center w-9 h-9 rounded-md border border-border bg-surface-elevated hover:bg-surface-hover transition-colors ${className}`}
      suppressHydrationWarning
    >
      {mounted && (isDark ? (
        <Sun className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
      ) : (
        <Moon className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
      ))}
    </button>
  )
}
