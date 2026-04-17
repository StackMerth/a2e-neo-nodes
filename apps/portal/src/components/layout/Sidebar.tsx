'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { NotificationBell } from './NotificationBell'
import {
  LayoutDashboard,
  Rocket,
  Server,
  Package,
  DollarSign,
  Wallet,
  ArrowDownToLine,
  Zap,
  Settings,
  LogOut,
  PanelLeftOpen,
  PanelLeftClose,
} from 'lucide-react'

const navItems = [
  { path: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/deploy', icon: Rocket, label: 'Deploy' },
  { path: '/nodes', icon: Server, label: 'Nodes' },
  { path: '/deployments', icon: Package, label: 'Deployments' },
  { path: '/earnings', icon: DollarSign, label: 'Earnings' },
  { path: '/payouts', icon: Wallet, label: 'Payouts' },
  { path: '/withdrawals', icon: ArrowDownToLine, label: 'Withdrawals' },
  { path: '/jobs', icon: Zap, label: 'Jobs' },
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
  const { user, logout } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen } = useSidebar()

  const handleLogout = async () => {
    await logout()
    router.push('/login')
  }

  const displayName = user?.email || user?.walletAddress
    ? user.email || `${user.walletAddress?.slice(0, 6)}...${user.walletAddress?.slice(-4)}`
    : 'User'

  const avatarLetter = (user?.email || user?.walletAddress || 'U').charAt(0).toUpperCase()

  return (
    <motion.aside
      className={`sidebar ${!sidebarOpen ? 'collapsed' : ''} ${sidebarOpen ? 'mobile-open' : ''}`}
      variants={sidebarVariants}
      animate={sidebarOpen ? 'open' : 'closed'}
      initial="closed"
      style={{ width: sidebarOpen ? 280 : 80 }}
    >
      {/* Logo */}
      <div className="sidebar-header">
        <motion.div
          className="logo"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => router.push('/dashboard')}
        >
          <div className="logo-icon">A2</div>
          <AnimatePresence>
            {sidebarOpen && (
              <motion.span
                className="logo-text"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
              >
                Portal
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>

        {sidebarOpen && (
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
        )}
      </div>

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

      {/* Navigation */}
      <nav className="sidebar-nav">
        {navItems.map((item, index) => {
          const isActive = pathname === item.path || (item.path !== '/dashboard' && pathname.startsWith(item.path))
          return (
            <Link
              key={item.path}
              href={item.path}
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

      {/* Footer */}
      <div className="sidebar-footer">
        <div className="user-info">
          <motion.div
            className="user-avatar"
            whileHover={{ scale: 1.05 }}
          >
            {avatarLetter}
          </motion.div>
          <motion.div
            className="user-details"
            variants={labelVariants}
          >
            <span className="user-name">{displayName}</span>
            <span className="user-role">{user?.role === 'ADMIN' ? 'Administrator' : user?.role === 'COMPUTE_BUYER' ? 'Compute Buyer' : 'Node Runner'}</span>
          </motion.div>
        </div>

        <NotificationBell collapsed={!sidebarOpen} />

        <motion.button
          className="logout-btn"
          onClick={handleLogout}
          whileHover={{ scale: 1.02, backgroundColor: 'rgba(239, 68, 68, 0.15)' }}
          whileTap={{ scale: 0.98 }}
          title={!sidebarOpen ? 'Logout' : undefined}
        >
          <LogOut size={20} />
          <motion.span variants={labelVariants}>Logout</motion.span>
        </motion.button>
      </div>
    </motion.aside>
  )
}
