'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from '@/components/layout/SidebarContext'
import { BuyerSidebar } from '@/components/layout/BuyerSidebar'
import { MobileMenuButton } from '@/components/layout/Navbar'
import { Footer } from '@/components/layout/Footer'

const mainEase: [number, number, number, number] = [0.4, 0, 0.2, 1]

export default function BuyerLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const { sidebarOpen, setSidebarOpen } = useSidebar()

  // Dual-role support: any authenticated user can view this surface;
  // node runners are no longer bounced back to /dashboard. Buyer-only
  // actions (submit request, top up, etc.) still work because they
  // create rows scoped to the user's own ID; nothing about the role
  // gates the operation itself.
  useEffect(() => {
    if (!loading && !user) {
      router.push('/login')
    }
  }, [user, loading, router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-t-transparent rounded-full" style={{ borderColor: 'var(--primary)', borderTopColor: 'transparent' }} />
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="app-layout">
      <MobileMenuButton />
      <BuyerSidebar />

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
          <Footer />
        </div>
      </motion.main>
    </div>
  )
}
