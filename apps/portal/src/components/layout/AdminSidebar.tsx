'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion } from 'framer-motion'
import { useSidebar } from './SidebarContext'
import { ViewSwitcher } from './ViewSwitcher'
import {
  LayoutDashboard,
  ArrowDownToLine,
  ArrowUpToLine,
  Cpu,
  Server,
  PanelLeftOpen,
  PanelLeftClose,
  ShieldCheck,
} from 'lucide-react'

// Admin navigation. Built fresh in this session as the platform's first
// admin surface. Items are scoped to the actionable admin endpoints
// that already have backend routes; everything else stays API-only
// until a separate UX pass decides it needs a page.
const navItems = [
  { path: '/admin', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/admin/buyer-withdrawals', icon: ArrowDownToLine, label: 'Buyer Withdrawals' },
  { path: '/admin/operator-withdrawals', icon: ArrowUpToLine, label: 'Operator Withdrawals' },
  { path: '/admin/compute', icon: Cpu, label: 'Compute Requests' },
  { path: '/admin/deployments', icon: Server, label: 'Deployments' },
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

export function AdminSidebar() {
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen } = useSidebar()
  const asideRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!sidebarOpen) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (asideRef.current?.contains(target)) return
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

      {/* Admin badge above the nav so it's obvious this is privileged
          surface and not a buyer/operator view. */}
      {sidebarOpen && (
        <motion.div
          className="px-4 pb-3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <div
            className="text-2xs font-mono uppercase tracking-wider px-2 py-1 rounded inline-flex items-center gap-1.5"
            style={{
              background: 'rgba(239, 68, 68, 0.12)',
              color: 'var(--danger)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
            }}
          >
            <ShieldCheck size={11} /> ADMIN
          </div>
        </motion.div>
      )}

      <ViewSwitcher collapsed={!sidebarOpen} />

      <nav className="sidebar-nav">
        {navItems.map((item, index) => {
          const isActive =
            pathname === item.path ||
            (item.path !== '/admin' && pathname.startsWith(item.path))
          return (
            <Link
              key={item.path}
              href={item.path}
              onClick={() => {
                if (typeof window !== 'undefined' && window.innerWidth < 1024) {
                  setSidebarOpen(false)
                } else {
                  setSidebarOpen(true)
                }
              }}
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
                    layoutId="admin-nav-indicator"
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                )}
                <div className="nav-icon-wrapper">
                  <item.icon size={20} className="nav-icon" />
                </div>
                <motion.span className="nav-label" variants={labelVariants}>
                  {item.label}
                </motion.span>
              </motion.div>
            </Link>
          )
        })}
      </nav>
    </motion.aside>
  )
}
