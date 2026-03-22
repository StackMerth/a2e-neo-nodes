'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const navigation = [
  { name: 'Overview', href: '/', icon: '📊' },
  { name: 'Nodes', href: '/nodes', icon: '🖥️' },
  { name: 'Routing Test', href: '/routing', icon: '🔀' },
  { name: 'Jobs', href: '/jobs', icon: '📋' },
  { name: 'Rates', href: '/rates', icon: '💰' },
  { name: 'Settings', href: '/settings', icon: '⚙️' },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="w-64 bg-surface border-r border-border flex flex-col">
      <div className="p-6 border-b border-border">
        <h1 className="text-xl font-bold text-text-primary">A²E Engine</h1>
        <p className="text-sm text-text-muted mt-1">Admin Dashboard</p>
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {navigation.map((item) => {
            const isActive = pathname === item.href
            return (
              <li key={item.name}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                  }`}
                >
                  <span>{item.icon}</span>
                  <span>{item.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="p-4 border-t border-border">
        <div className="px-4 py-2 text-xs text-text-muted">
          <div>API: a2e.byredstone.com</div>
          <div className="mt-1">Status: <span className="text-success">Connected</span></div>
        </div>
      </div>
    </aside>
  )
}
