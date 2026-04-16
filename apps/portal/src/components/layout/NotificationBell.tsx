'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Bell } from 'lucide-react'
import { motion } from 'framer-motion'
import { notifications as notifApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { useWebSocket } from '@/hooks/useWebSocket'

interface Notification {
  id: string
  type: string
  title: string
  message: string
  read: boolean
  createdAt: string
}

const labelVariants = {
  open: { opacity: 1, x: 0, display: 'block', transition: { delay: 0.1 } },
  closed: { opacity: 0, x: -10, transitionEnd: { display: 'none' } },
}

export function NotificationBell({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useAuth()
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user) return
    const fetchCount = async () => {
      try {
        const data = await notifApi.unreadCount()
        setCount(data.count)
      } catch { /* ignore */ }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 30000)
    return () => clearInterval(interval)
  }, [user])

  useEffect(() => {
    if (!open || !user) return
    const fetchItems = async () => {
      setLoading(true)
      try {
        const data = await notifApi.list({ limit: '5' }) as { notifications: Notification[] }
        setItems(data.notifications)
      } catch { /* ignore */ }
      setLoading(false)
    }
    fetchItems()
  }, [open, user])

  const handleNewNotification = useCallback(() => {
    setCount(prev => prev + 1)
    if (open) {
      notifApi.list({ limit: '5' }).then(data => {
        setItems((data as { notifications: Notification[] }).notifications)
      }).catch(() => {})
    }
  }, [open])

  useWebSocket({
    events: { 'notification:new': handleNewNotification },
  })

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleMarkAllRead = async () => {
    await notifApi.markAllRead()
    setCount(0)
    setItems(prev => prev.map(n => ({ ...n, read: true })))
  }

  const handleMarkRead = async (id: string) => {
    await notifApi.markRead(id)
    setCount(prev => Math.max(0, prev - 1))
    setItems(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
  }

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  return (
    <div className="relative" ref={ref}>
      <motion.button
        className="sidebar-notif-btn"
        onClick={() => setOpen(!open)}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        title={collapsed ? 'Notifications' : undefined}
      >
        <Bell size={20} />
        <motion.span variants={labelVariants} animate={collapsed ? 'closed' : 'open'}>
          Notifications
        </motion.span>
        {count > 0 && (
          <span className="sidebar-notif-badge">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </motion.button>

      {open && (
        <div className="fixed ml-2 w-80 rounded-xl shadow-xl animate-scaleIn overflow-hidden z-50"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            bottom: '80px',
            left: '80px',
          }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Notifications</span>
            {count > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs hover:underline"
                style={{ color: 'var(--primary)' }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-4 text-center text-sm" style={{ color: 'var(--text-muted)' }}>No notifications</div>
            ) : (
              items.map(item => (
                <button
                  key={item.id}
                  onClick={() => !item.read && handleMarkRead(item.id)}
                  className="w-full text-left px-4 py-3 transition-colors"
                  style={{
                    borderBottom: '1px solid var(--border-color)',
                    background: !item.read ? 'rgba(34, 197, 94, 0.05)' : 'transparent',
                  }}
                >
                  <div className="flex items-start gap-2">
                    {!item.read && (
                      <span
                        className="mt-1.5 w-2 h-2 rounded-full shrink-0"
                        style={{ background: 'var(--primary)' }}
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.title}</p>
                      <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{item.message}</p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)', fontSize: '0.625rem' }}>{timeAgo(item.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
