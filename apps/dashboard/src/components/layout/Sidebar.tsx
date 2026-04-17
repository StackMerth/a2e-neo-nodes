'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { api } from '@/lib/api'
import {
  LayoutDashboard,
  Server,
  Briefcase,
  GitBranch,
  Users,
  Wallet,
  Rocket,
  Monitor,
  TrendingUp,
  BarChart3,
  CreditCard,
  DollarSign,
  Receipt,
  FileText,
  ClipboardCheck,
  Settings,
  LogOut,
  PanelLeftOpen,
  PanelLeftClose,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface NavItem {
  path: string
  icon: LucideIcon
  label: string
  badgeKey?: string // Key to look up badge count
}

interface NavGroup {
  title: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    title: 'MAIN',
    items: [
      { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
      { path: '/nodes', icon: Server, label: 'Nodes' },
      { path: '/jobs', icon: Briefcase, label: 'Jobs' },
      { path: '/routing', icon: GitBranch, label: 'Routing' },
    ],
  },
  {
    title: 'INVESTORS',
    items: [
      { path: '/node-runners', icon: Users, label: 'Node Runners' },
      { path: '/investments', icon: Wallet, label: 'Investments' },
      { path: '/deployments', icon: Rocket, label: 'Deployments', badgeKey: 'deployments' },
    ],
  },
  {
    title: 'DEMAND',
    items: [
      { path: '/compute', icon: Monitor, label: 'Compute', badgeKey: 'compute' },
    ],
  },
  {
    title: 'MARKET',
    items: [
      { path: '/rates', icon: TrendingUp, label: 'Rates' },
    ],
  },
  {
    title: 'FINANCE',
    items: [
      { path: '/financial', icon: BarChart3, label: 'Financial' },
      { path: '/payments', icon: CreditCard, label: 'Payments' },
      { path: '/earnings', icon: DollarSign, label: 'Earnings' },
      { path: '/costs', icon: Receipt, label: 'Costs' },
      { path: '/reports', icon: FileText, label: 'Reports' },
      { path: '/withdrawals', icon: Wallet, label: 'Withdrawals', badgeKey: 'withdrawals' },
    ],
  },
  {
    title: 'SYSTEM',
    items: [
      { path: '/audit', icon: ClipboardCheck, label: 'Audit' },
      { path: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
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
  const [badges, setBadges] = useState<Record<string, number>>({})

  // Fetch pending counts for badge indicators
  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const [deployData, computeData, withdrawalData] = await Promise.all([
          api.deployments.list('DEPLOYMENT_REQUESTED').catch(() => null),
          api.compute.list('PENDING').catch(() => null),
          api.withdrawals.list('PENDING').catch(() => null),
        ])
        setBadges({
          deployments: (deployData as { deployments?: unknown[] })?.deployments?.length ?? 0,
          compute: (computeData as { requests?: unknown[] })?.requests?.length ?? 0,
          withdrawals: (withdrawalData as { withdrawals?: unknown[] })?.withdrawals?.length ?? 0,
        })
      } catch { /* ignore */ }
    }
    fetchBadges()
    const interval = setInterval(fetchBadges, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleLogout = () => {
    logout()
    router.push('/login')
  }

  const displayName = user?.username || 'Admin'
  const avatarLetter = (user?.username || 'A').charAt(0).toUpperCase()

  let itemIndex = 0

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
          onClick={() => router.push('/')}
        >
          <div className="logo-icon">A²E</div>
          <AnimatePresence>
            {sidebarOpen && (
              <motion.span
                className="logo-text"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
              >
                Admin
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
        {navGroups.map((group) => (
          <div key={group.title}>
            <AnimatePresence>
              {sidebarOpen && (
                <motion.div
                  className="nav-group-title"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {group.title}
                </motion.div>
              )}
            </AnimatePresence>

            {group.items.map((item) => {
              const currentIndex = itemIndex++
              const isActive = item.path === '/'
                ? pathname === '/'
                : pathname === item.path || pathname.startsWith(item.path + '/')

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
                    transition={{ delay: currentIndex * 0.03 }}
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
                      {item.badgeKey && (badges[item.badgeKey] ?? 0) > 0 && (
                        <span className="nav-badge">{badges[item.badgeKey]}</span>
                      )}
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
          </div>
        ))}
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
            <span className="user-role">{user?.role || 'Administrator'}</span>
          </motion.div>
        </div>

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
