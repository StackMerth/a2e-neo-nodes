'use client'

import { useAuth } from '@/hooks/useAuth'
import { usePathname } from 'next/navigation'
import { Header } from './Header'
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
    <>
      <WebSocketNotifier />
      <Header />
      <main className="max-w-7xl mx-auto px-6 py-8">
        {children}
      </main>
      <footer className="border-t border-border mt-16 py-8">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <div>
            <p className="text-sm text-text-muted">A²E Engine</p>
            <p className="text-xs text-text-muted mt-1">Arbitrage & Orchestration for TokenOS</p>
          </div>
          <div className="flex items-center gap-4 text-text-muted">
            <a
              href="https://compute.tokenos.ai"
              target="_blank"
              rel="noopener"
              className="text-sm hover:text-accent transition-colors"
            >
              TokenOS
            </a>
            <a
              href="https://a2e.byredstone.com/health"
              target="_blank"
              rel="noopener"
              className="text-sm hover:text-accent transition-colors"
            >
              API Status
            </a>
          </div>
        </div>
      </footer>
    </>
  )
}
