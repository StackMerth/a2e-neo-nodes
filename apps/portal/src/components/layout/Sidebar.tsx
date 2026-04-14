'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const sidebarLinks = [
  { href: '/dashboard', label: 'Dashboard', icon: '\u{1F4CA}' },
  { href: '/deploy', label: 'Deploy', icon: '\u{1F680}' },
  { href: '/nodes', label: 'Nodes', icon: '\u{1F5A5}\u{FE0F}' },
  { href: '/deployments', label: 'Deployments', icon: '\u{1F4E6}' },
  { href: '/earnings', label: 'Earnings', icon: '\u{1F4B0}' },
  { href: '/payouts', label: 'Payouts', icon: '\u{1F4B8}' },
  { href: '/jobs', label: 'Jobs', icon: '\u{26A1}' },
  { href: '/settings', label: 'Settings', icon: '\u{2699}\u{FE0F}' },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden lg:block w-56 shrink-0">
      <nav className="sticky top-20 space-y-1">
        {sidebarLinks.map(link => {
          const active = pathname === link.href || (link.href !== '/dashboard' && pathname.startsWith(link.href))
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                active
                  ? 'bg-accent/10 text-accent border border-accent/20'
                  : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover border border-transparent'
              }`}
            >
              <span className="text-base">{link.icon}</span>
              {link.label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
