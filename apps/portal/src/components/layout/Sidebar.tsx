'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useSidebar } from './SidebarContext'
import { ViewSwitcher } from './ViewSwitcher'
import {
  LayoutDashboard,
  Rocket,
  Server,
  Package,
  DollarSign,
  Wallet,
  Zap,
  Settings,
  PanelLeftOpen,
  PanelLeftClose,
  Users,
  PiggyBank,
  Sparkles,
} from 'lucide-react'

const navItems = [
  { path: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/deploy', icon: Rocket, label: 'Deploy' },
  { path: '/nodes', icon: Server, label: 'Nodes' },
  { path: '/deployments', icon: Package, label: 'Deployments' },
  { path: '/earnings', icon: DollarSign, label: 'Earnings' },
  // ZK-UBI: passive earnings on idle GPU via Boundless proof work.
  // Opt-in per node, 95/5 split, custodial USD payout.
  { path: '/ubi', icon: Sparkles, label: 'ZK-UBI' },
  // Pre-loaded credit, same wallet as the buyer portal. Operators top
  // up via Stripe / USDC here, then spend on deployments without a
  // fresh transaction each time.
  { path: '/balance', icon: PiggyBank, label: 'Balance' },
  { path: '/payouts', icon: Wallet, label: 'Payouts' },
  { path: '/jobs', icon: Zap, label: 'Jobs' },
  { path: '/referral', icon: Users, label: 'Referrals' },
  { path: '/settings', icon: Settings, label: 'Settings' },
]

const sidebarEase: [number, number, number, number] = [0.4, 0, 0.2, 1]

const sidebarVariants = {
  open: { width: 280, transition: { duration: 0.3, ease: sidebarEase } },
  closed: { width: 80, transition: { duration: 0.3, ease: sidebarEase } },
}

const labelVariants = {
  open: { opacity: 1, x: 0, display: 'block', transition: { delay: 0.1 } },
  closed: { opacity: 0, x: -10, transitionEnd: { display: 'none' } },
}

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen } = useSidebar()
  const asideRef = useRef<HTMLElement | null>(null)

  // Auto-close on outside click when the sidebar is expanded. Anchored
  // to the <aside> ref; the click only counts as "outside" when it
  // lands neither inside the sidebar nor on the mobile-menu trigger
  // button (which has its own toggle handler).
  useEffect(() => {
    if (!sidebarOpen) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (asideRef.current?.contains(target)) return
      // Ignore clicks on the mobile menu toggle button (data-attr) so
      // the toggle does not fight the close.
      if ((target as Element).closest?.('[data-mobile-menu-trigger]')) return
      setSidebarOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [sidebarOpen, setSidebarOpen])

  return (
    <motion.aside
      ref={asideRef}
      className={`sidebar ${!sidebarOpen ? 'collapsed' : ''} ${sidebarOpen ? 'mobile-open' : ''}`}
      variants={sidebarVariants}
      animate={sidebarOpen ? 'open' : 'closed'}
      initial="closed"
      style={{ width: sidebarOpen ? 280 : 80 }}
    >
      {/* Sidebar header (logo + portal text) removed - TopHeader owns
          the brand now. Only the expand/collapse control remains. */}
      {sidebarOpen && (
        <div className="flex justify-end px-4 py-3">
          <motion.button
            className="collapse-btn"
            onClick={() => setSidebarOpen(false)}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            title="Collapse sidebar"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <PanelLeftClose size={20} />
          </motion.button>
        </div>
      )}

      {!sidebarOpen && (
        <motion.div
          className="sidebar-toggle-collapsed"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <motion.button
            className="collapse-btn centered"
            onClick={() => setSidebarOpen(true)}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            title="Expand sidebar"
          >
            <PanelLeftOpen size={20} />
          </motion.button>
        </motion.div>
      )}

      {/* Dual-role view switcher: flip between Node Runner and Buyer
          surfaces. Lives at the top of the sidebar so it's always
          one click away. */}
      <ViewSwitcher collapsed={!sidebarOpen} />

      {/* Navigation */}
      <nav className="sidebar-nav">
        {navItems.map((item, index) => {
          const isActive = pathname === item.path || (item.path !== '/dashboard' && pathname.startsWith(item.path))
          return (
            <Link
              key={item.path}
              href={item.path}
              // Tapping any nav item collapses the sidebar so the
              // destination page is in focus immediately. On narrow
              // viewports this dismisses the mobile overlay; on
              // desktop it shrinks back to the icon rail.
              onClick={() => setSidebarOpen(false)}
              className={`nav-item ${isActive ? 'active' : ''}`}
              title={!sidebarOpen ? item.label : undefined}
            >
              <motion.div
                className="nav-item-content"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                whileHover={{ x: 4 }}
              >
                {isActive && (
                  <motion.div
                    className="nav-indicator"
                    layoutId="nav-indicator"
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                )}
                <div className="nav-icon-wrapper">
                  <item.icon size={20} className="nav-icon" />
                </div>
                <motion.span
                  className="nav-label"
                  variants={labelVariants}
                >
                  {item.label}
                </motion.span>
              </motion.div>
            </Link>
          )
        })}
      </nav>

      {/* Sidebar footer intentionally trimmed: identity, notifications,
          and theme toggle moved to the TopHeader so the sidebar is
          pure navigation. */}
    </motion.aside>
  )
}
