'use client'

import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { Sidebar } from './Sidebar'
import { MobileMenuButton } from './MobileMenuButton'
import { WebSocketNotifier } from '@/components/WebSocketNotifier'

const mainEase: [number, number, number, number] = [0.4, 0, 0.2, 1]

export function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen } = useSidebar()

  if (pathname === '/login') {
    return <>{children}</>
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin w-8 h-8 border-2 border-t-transparent rounded-full" style={{ borderColor: 'var(--primary)', borderTopColor: 'transparent' }} />
          <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="app-layout">
      <WebSocketNotifier />
      <MobileMenuButton />
      <Sidebar />

      {/* Mobile Overlay */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            className="mobile-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </AnimatePresence>

      <motion.main
        className="main-content"
        initial={{ marginLeft: 80 }}
        animate={{ marginLeft: sidebarOpen ? 280 : 80 }}
        transition={{ duration: 0.3, ease: mainEase }}
      >
        <div className="page-container">
          {children}

          <footer className="admin-footer">
            <span>&copy; {new Date().getFullYear()} A²E Engine</span>
            {' \u2022 '}
            <a href="https://compute.tokenos.ai" target="_blank" rel="noopener noreferrer">TokenOS</a>
            {' \u2022 '}
            <a href={`${process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'}/health`} target="_blank" rel="noopener noreferrer">API Status</a>
          </footer>
        </div>
      </motion.main>
    </div>
  )
}
