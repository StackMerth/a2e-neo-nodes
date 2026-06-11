'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from '@/components/layout/SidebarContext'
import { AdminSidebar } from '@/components/layout/AdminSidebar'
import { Footer } from '@/components/layout/Footer'
import { TopHeader } from '@/components/layout/TopHeader'
import { OfflineBanner } from '@/components/layout/OfflineBanner'
import {
  AdminPendingCountsProvider,
  useAdminTabTitleBadge,
} from '@/components/layout/AdminPendingCountsContext'

const mainEase: [number, number, number, number] = [0.4, 0, 0.2, 1]

/**
 * Mounted inside the provider; runs the tab-title side-effect so every
 * admin route shows "(N) ..." in the browser tab when items are
 * waiting. Returns null because all the work is in useEffect.
 */
function TabTitleBadge() {
  useAdminTabTitleBadge()
  return null
}

/**
 * Admin section root layout.
 *
 * Auth gate:
 *   - No user / still loading: redirect to /login
 *   - User but role !== 'ADMIN': redirect to /buyer/dashboard
 *   - User with role === 'ADMIN': render the admin shell
 *
 * The redirect-to-buyer-dashboard for non-admin uses the user-visible
 * default surface rather than throwing a 403 page; non-admins
 * stumbling onto an /admin URL aren't doing anything malicious, they
 * just clicked a wrong link.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const { sidebarOpen, setSidebarOpen } = useSidebar()

  useEffect(() => {
    if (loading) return
    if (!user) {
      router.push('/login')
      return
    }
    if (user.role !== 'ADMIN') {
      router.push('/buyer/dashboard')
    }
  }, [user, loading, router])

  if (loading || !user || user.role !== 'ADMIN') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div
          className="animate-spin w-8 h-8 border-2 border-t-transparent rounded-full"
          style={{ borderColor: 'var(--primary)', borderTopColor: 'transparent' }}
        />
      </div>
    )
  }

  return (
    <AdminPendingCountsProvider>
      <TabTitleBadge />
      <div className="app-layout pt-16">
        <TopHeader />
        <AdminSidebar />

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
            <OfflineBanner />
            {children}
            <Footer />
          </div>
        </motion.main>
      </div>
    </AdminPendingCountsProvider>
  )
}
