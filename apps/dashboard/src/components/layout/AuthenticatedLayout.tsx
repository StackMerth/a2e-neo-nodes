'use client'

import { useAuth } from '@/hooks/useAuth'
import { usePathname } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { WebSocketNotifier } from '@/components/WebSocketNotifier'

export function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()
  const pathname = usePathname()

  // Don't show layout on login page
  if (pathname === '/login') {
    return <>{children}</>
  }

  // Show loading state while checking auth
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 bg-accent rounded-xl flex items-center justify-center">
            <span className="text-background font-bold">A²</span>
          </div>
          <p className="text-text-muted">Loading...</p>
        </div>
      </div>
    )
  }

  // If not authenticated and not on login page, the AuthProvider will redirect
  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-screen bg-background">
      <WebSocketNotifier />
      <Sidebar />

      {/* Main content area - offset by collapsed sidebar width (16 = w-16) */}
      <div className="pl-16 transition-all duration-300">
        {/* Page content */}
        <main className="p-6">
          <div className="max-w-[1800px] mx-auto">
            {children}
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-border mt-8 py-6 px-6">
          <div className="max-w-[1800px] mx-auto flex items-center justify-between text-sm text-text-muted">
            <div>
              <span>A²E Engine</span>
              <span className="mx-2">·</span>
              <span>TokenOS Arbitrage & Orchestration</span>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://compute.tokenos.ai"
                target="_blank"
                rel="noopener"
                className="hover:text-accent transition-colors"
              >
                TokenOS
              </a>
              <a
                href="https://a2e.byredstone.com/health"
                target="_blank"
                rel="noopener"
                className="hover:text-accent transition-colors"
              >
                API Status
              </a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
