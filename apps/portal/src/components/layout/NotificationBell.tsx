'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
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

export function NotificationBell() {
  const { user } = useAuth()
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Fetch unread count periodically
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

  // Fetch notifications when dropdown opens
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

  // Real-time: refresh count when new notification arrives
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

  // Close on outside click
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
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 text-text-secondary hover:text-text-primary transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-error text-white text-2xs font-bold rounded-full w-4 h-4 flex items-center justify-center animate-gentle-pulse">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-surface-elevated border border-border rounded-xl shadow-xl animate-scaleIn overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-text-primary">Notifications</span>
            {count > 0 && (
              <button onClick={handleMarkAllRead} className="text-xs text-accent hover:underline">
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-text-muted text-sm">Loading...</div>
            ) : items.length === 0 ? (
              <div className="p-4 text-center text-text-muted text-sm">No notifications</div>
            ) : (
              items.map(item => (
                <button
                  key={item.id}
                  onClick={() => !item.read && handleMarkRead(item.id)}
                  className={`w-full text-left px-4 py-3 border-b border-border/50 hover:bg-surface-hover transition-colors ${!item.read ? 'bg-accent/5' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    {!item.read && <span className="mt-1.5 w-2 h-2 rounded-full bg-accent shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{item.title}</p>
                      <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{item.message}</p>
                      <p className="text-2xs text-text-muted mt-1">{timeAgo(item.createdAt)}</p>
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
