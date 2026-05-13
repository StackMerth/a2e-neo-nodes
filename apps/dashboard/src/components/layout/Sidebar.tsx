'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/hooks/useAuth'
import { useSidebar } from './SidebarContext'
import { useSocket } from '@/hooks/useWebSocket'
import { api } from '@/lib/api'
import { ThemeToggle } from '@/components/theme-toggle'
import { UserMenu } from './UserMenu'
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
  PanelLeftOpen,
  PanelLeftClose,
  Globe,
  Star,
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
      { path: '/ratings', icon: Star, label: 'Ratings', badgeKey: 'ratings' },
    ],
  },
  {
    title: 'MARKET',
    items: [
      { path: '/rates', icon: TrendingUp, label: 'Rates' },
      { path: '/external', icon: Globe, label: 'External Markets' },
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
  const { user } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const { sidebarOpen, setSidebarOpen } = useSidebar()
  const [badges, setBadges] = useState<Record<string, number>>({})
  const { on, off } = useSocket()

  // Compute badge counts. compute = PENDING + WAITLISTED so the admin
  // sees the full review backlog, not just the unallocated PENDING set.
  // The list API returns counts for every status; we read both buckets.
  const fetchBadges = useCallback(async () => {
    try {
      const [deployData, computeData, withdrawalData, ratingsData] = await Promise.all([
        api.deployments.list('DEPLOYMENT_REQUESTED').catch(() => null),
        api.compute.list().catch(() => null), // no status filter -> get counts.{pending,waitlisted}
        api.withdrawals.list('PENDING').catch(() => null),
        api.ratings.list('PENDING').catch(() => null),
      ])
      const computeCounts = (computeData as { counts?: { pending?: number; waitlisted?: number } } | null)?.counts
      setBadges({
        deployments: (deployData as { deployments?: unknown[] })?.deployments?.length ?? 0,
        compute: (computeCounts?.pending ?? 0) + (computeCounts?.waitlisted ?? 0),
        withdrawals: (withdrawalData as { withdrawals?: unknown[] })?.withdrawals?.length ?? 0,
        ratings: (ratingsData as { counts?: { pending?: number } } | null)?.counts?.pending ?? 0,
      })
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchBadges()
    // 30s poll as a backstop; WebSocket below is the primary path.
    const interval = setInterval(fetchBadges, 30000)
    return () => clearInterval(interval)
  }, [fetchBadges])

  // Real-time badge updates: any compute lifecycle event triggers a
  // re-fetch so the badge stays exact (no drift from manual increments).
  // Re-fetch is cheap (single list call) and runs only on events, not
  // on every tick. This is what makes the badge feel live.
  useEffect(() => {
    on('compute:request:new', fetchBadges)
    on('compute:waitlisted', fetchBadges)
    on('compute:allocated', fetchBadges)
    on('compute:terminated', fetchBadges)
    // M3: rating events also bump the Ratings sidebar badge
    on('rating:new', fetchBadges)
    return () => {
      off('compute:request:new')
      off('compute:waitlisted')
      off('compute:allocated')
      off('compute:terminated')
      off('rating:new')
    }
  }, [on, off, fetchBadges])

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
      {/* Brand. Collapsed: a clean primary-toned monogram "T" tile.
          Expanded: the full two-tone TokenOS_DeAI wordmark + small
          Admin pill, matching the portal TopHeader treatment. */}
      <div className="sidebar-header">
        <motion.div
          className="logo"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => router.push('/')}
          style={{ minWidth: 0, flex: 1 }}
        >
          {!sidebarOpen ? (
            <span
              className="inline-flex items-center justify-center font-display"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-dark, var(--primary)) 100%)',
                color: '#ffffff',
                fontWeight: 900,
                fontSize: 16,
                letterSpacing: '-0.02em',
                flexShrink: 0,
              }}
              title="TokenOS DeAI Admin"
            >
              T
            </span>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="font-display tracking-tight"
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 900,
                  letterSpacing: '-0.02em',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ color: 'var(--text-primary)' }}>TokenOS</span>
                <span style={{ color: 'var(--primary)' }}>_DeAI</span>
              </span>
              <AnimatePresence>
                <motion.span
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.2 }}
                  className="font-mono text-[10px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded-sm shrink-0"
                  style={{
                    color: 'var(--primary)',
                    background: 'rgba(34, 197, 94, 0.10)',
                    border: '1px solid rgba(34, 197, 94, 0.30)',
                  }}
                >
                  Admin
                </motion.span>
              </AnimatePresence>
            </div>
          )}
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
                  onClick={() => setSidebarOpen(false)}
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

      {/* Footer with avatar dropdown */}
      <div className="sidebar-footer">
        <div className="flex justify-center mb-2">
          <ThemeToggle />
        </div>

        <UserMenu
          collapsed={!sidebarOpen}
          displayName={displayName}
          avatarLetter={avatarLetter}
          role={user?.role ?? 'Administrator'}
        />
      </div>
    </motion.aside>
  )
}
