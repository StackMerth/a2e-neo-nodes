'use client'

import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { Sidebar } from './Sidebar'
import { TopHeader } from './TopHeader'
import { WebSocketNotifier } from '@/components/WebSocketNotifier'
import { AdminLoadingScreen } from '@/components/AdminLoadingScreen'

const mainEase: [number, number, number, number] = [0.4, 0, 0.2, 1]

export function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen } = useSidebar()

  if (pathname === '/login') {
    return <>{children}</>
  }

  if (isLoading) {
    return <AdminLoadingScreen />
  }

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="app-layout">
      <WebSocketNotifier />
      <TopHeader />
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
            <span>&copy; {new Date().getFullYear()} TokenOS DeAI Engine</span>
            {' \u2022 '}
            <a href="https://market.tokenos.ai" target="_blank" rel="noopener noreferrer">Marketplace</a>
            {' \u2022 '}
            <a href="https://user.tokenos.ai" target="_blank" rel="noopener noreferrer">User Portal</a>
            {' \u2022 '}
            <a href={`${process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'}/health`} target="_blank" rel="noopener noreferrer">API Status</a>
          </footer>
        </div>
      </motion.main>
    </div>
  )
}
