'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from '@/components/layout/SidebarContext'
import { Sidebar } from '@/components/layout/Sidebar'
import { Footer } from '@/components/layout/Footer'
import { RoleIntroCallout } from '@/components/layout/RoleIntroCallout'
import { TopHeader } from '@/components/layout/TopHeader'
import { VerifyEmailBanner } from '@/components/layout/VerifyEmailBanner'

const mainEase: [number, number, number, number] = [0.4, 0, 0.2, 1]

export default function NodeRunnerLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const { sidebarOpen, setSidebarOpen } = useSidebar()

  // Dual-role support: any authenticated user can view this surface;
  // the previous role-based redirect to /buyer/dashboard is removed.
  // Data on every page is already scoped by userId, so a buyer who
  // pokes around here just sees empty node/earning lists.
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
    <div className="app-layout pt-16">
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
          {/* Soft-gate verification reminder. Hidden when the user has
              already verified or has no email on file (wallet-only). */}
          <VerifyEmailBanner />
          {/* Self-gating callout: only renders if this user does not
              yet have the matching dual-identity flag. */}
          <RoleIntroCallout />
          {children}
          <Footer />
        </div>
      </motion.main>
    </div>
  )
}
