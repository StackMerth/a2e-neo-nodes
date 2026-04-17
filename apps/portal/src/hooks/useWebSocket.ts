'use client'

import { useEffect, useRef, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from './useAuth'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

type EventHandler = (data: unknown) => void

interface UseWebSocketOptions {
  /** Events to subscribe to */
  events?: Record<string, EventHandler>
  /** Whether to connect automatically (default: true) */
  enabled?: boolean
}

/**
 * WebSocket hook for real-time updates from the A²E server.
 * Authenticates with JWT token. Auto-reconnects on disconnect.
 */
export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { events = {}, enabled = true } = options
  const { user } = useAuth()
  const socketRef = useRef<Socket | null>(null)
  const eventsRef = useRef(events)
  eventsRef.current = events

  const connect = useCallback(() => {
    const token = typeof window !== 'undefined'
      ? localStorage.getItem('a2e_access_token')
      : null

    if (!token || !user) return

    // Disconnect existing socket
    if (socketRef.current?.connected) {
      socketRef.current.disconnect()
    }

    const socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    })

    socket.on('connect', () => {
      // Subscribe to all requested events
      const eventNames = Object.keys(eventsRef.current)
      if (eventNames.length > 0) {
        socket.emit('subscribe', eventNames)
      }
    })

    // Attach event listeners
    for (const [event, handler] of Object.entries(eventsRef.current)) {
      socket.on(event, handler)
    }

    socket.on('connect_error', (err) => {
      console.warn('[WebSocket] Connection error:', err.message)
    })

    socketRef.current = socket
  }, [user])

  useEffect(() => {
    if (!enabled || !user) return

    connect()

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
        socketRef.current = null
      }
    }
  }, [enabled, user, connect])

  // Re-attach event listeners when events change
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return

    for (const [event, handler] of Object.entries(events)) {
      socket.off(event)
      socket.on(event, handler)
    }
  }, [events])

  return {
    socket: socketRef.current,
    connected: socketRef.current?.connected ?? false,
  }
}
