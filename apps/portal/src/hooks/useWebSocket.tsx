'use client'

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from './useAuth'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

type EventHandler = (data: unknown) => void

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'

interface WebSocketContextValue {
  socket: Socket | null
  status: ConnectionStatus
  /**
   * Internal: how many times the underlying socket has flipped to
   * 'connected' since the provider mounted. Hooks use this counter to
   * detect "we just reconnected" vs. "initial connect" without each
   * one having to track their own previousStatus.
   */
  connectGeneration: number
}

const WebSocketContext = createContext<WebSocketContextValue>({
  socket: null,
  status: 'connecting',
  connectGeneration: 0,
})

/**
 * Singleton WebSocket connection for the entire portal. Mounted once
 * in providers.tsx so every consumer (NotificationBell, dashboard,
 * buyer/active, indicator…) shares the same socket rather than each
 * opening their own.
 *
 * Built specifically for the installed-PWA use case where the user is
 * on a flaky mobile network. Beyond the vanilla socket.io reconnect:
 *
 *   1. Infinite reconnect attempts (vs. the previous 10-try cap that
 *      gave up after ~5 minutes of consecutive failures).
 *   2. `visibilitychange` listener — when the tab becomes visible
 *      again, force an immediate reconnect attempt instead of waiting
 *      for the next backoff tick. Mobile browsers throttle background
 *      tabs aggressively, so the cached socket is often stale by the
 *      time the user comes back; we want a fresh check right away.
 *   3. `online` listener — same idea for browser-reported network
 *      restoration. Skip the backoff, retry immediately.
 *   4. `offline` listener — set status='offline' so the UI indicator
 *      can show that we're not even trying (vs. trying and failing).
 *   5. ConnectionStatus exposed via context — drives the dot
 *      indicator in TopHeader. Consumers can also gate features
 *      (e.g. "live count" labels) on status === 'connected'.
 *   6. connectGeneration counter — useWebSocket hook reads it to
 *      detect reconnects without each consumer tracking previousStatus.
 */
export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const socketRef = useRef<Socket | null>(null)
  const [socket, setSocket] = useState<Socket | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [connectGeneration, setConnectGeneration] = useState(0)

  const connect = useCallback(() => {
    const token = typeof window !== 'undefined'
      ? localStorage.getItem('a2e_access_token')
      : null
    if (!token || !user) return

    // Tear down any prior socket so we never have two parallel
    // connections fighting over the same auth.
    if (socketRef.current) {
      socketRef.current.removeAllListeners()
      socketRef.current.disconnect()
      socketRef.current = null
    }

    setStatus((prev) => (prev === 'connected' || prev === 'reconnecting' ? 'reconnecting' : 'connecting'))

    const next = io(WS_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      // Infinite attempts — long subway rides, switching networks,
      // etc. The socket should come back the moment the user has
      // signal again, not give up after 10 tries.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      // Cap how long socket.io waits before considering a connect
      // attempt 'failed'. Faster failures = faster backoff loop.
      timeout: 8000,
    })

    next.on('connect', () => {
      setStatus('connected')
      // Bump the generation on every successful connect. Consumer
      // hooks compare against their cached value to detect reconnects.
      setConnectGeneration((g) => g + 1)
    })

    next.on('disconnect', () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setStatus('offline')
      } else {
        setStatus('reconnecting')
      }
    })

    next.on('connect_error', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[WebSocket] Connection error:', err.message)
    })

    socketRef.current = next
    setSocket(next)
  }, [user])

  // Open the socket once the user is signed in. Reconnect logic lives
  // inside the connect() function above; this effect just kicks it
  // off and tears down on logout.
  useEffect(() => {
    if (!user) {
      // No user -> no socket. Tear down anything from a previous
      // session so the next sign-in opens a fresh authenticated
      // connection.
      if (socketRef.current) {
        socketRef.current.removeAllListeners()
        socketRef.current.disconnect()
        socketRef.current = null
        setSocket(null)
      }
      setStatus('connecting')
      return
    }

    connect()

    return () => {
      if (socketRef.current) {
        socketRef.current.removeAllListeners()
        socketRef.current.disconnect()
        socketRef.current = null
        setSocket(null)
      }
    }
  }, [user, connect])

  // Browser visibility + network listeners: come back the moment the
  // user is reachable again, don't wait for the next backoff tick.
  useEffect(() => {
    if (!user) return
    if (typeof window === 'undefined') return

    const forceReconnectIfNeeded = () => {
      const s = socketRef.current
      if (!s) return
      if (!s.connected) {
        s.connect()
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        forceReconnectIfNeeded()
      }
    }
    const onOnline = () => {
      setStatus('reconnecting')
      forceReconnectIfNeeded()
    }
    const onOffline = () => setStatus('offline')

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    if (navigator.onLine === false) setStatus('offline')

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [user])

  return (
    <WebSocketContext.Provider value={{ socket, status, connectGeneration }}>
      {children}
    </WebSocketContext.Provider>
  )
}

interface UseWebSocketOptions {
  /** Events to subscribe to on the shared socket. */
  events?: Record<string, EventHandler>
  /**
   * Fires when the socket reconnects after a real disconnection (not
   * on the first connect). Consumers use this to refetch state that
   * may have changed during the gap.
   */
  onReconnect?: () => void
}

interface UseWebSocketResult {
  socket: Socket | null
  /** True iff the underlying socket is currently connected. */
  connected: boolean
  /** Granular state for UI indicators. */
  status: ConnectionStatus
}

/**
 * Subscribe to events on the shared WebSocket connection. Attaches
 * the handlers in `events` on every connect, including reconnects,
 * because the server doesn't remember subscriptions across drops.
 *
 * Pass `onReconnect` if your component needs to refetch state after
 * a connection gap (e.g. a list view that depends on events you might
 * have missed while offline).
 */
export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketResult {
  const { events = {}, onReconnect } = options
  const { socket, status, connectGeneration } = useContext(WebSocketContext)
  const eventsRef = useRef(events)
  eventsRef.current = events
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  // Generation we've already 'consumed' — used to fire onReconnect
  // only on transitions from 'reconnecting' -> 'connected', not on
  // the first connect (generation === 1).
  const lastGenerationRef = useRef(0)

  // Attach + detach listeners. Re-runs when socket changes (provider
  // creates a new socket on logout/login) or when events change.
  useEffect(() => {
    if (!socket) return
    const eventList = Object.entries(eventsRef.current)
    for (const [event, handler] of eventList) {
      socket.on(event, handler)
    }
    // Tell the server which events we care about. It scopes broadcasts
    // accordingly — without this our 'on' handlers would fire only for
    // global events, not the per-user subscriptions.
    if (eventList.length > 0) {
      socket.emit('subscribe', eventList.map(([e]) => e))
    }
    return () => {
      for (const [event, handler] of eventList) {
        socket.off(event, handler)
      }
    }
  }, [socket, events])

  // Re-subscribe + fire onReconnect on every reconnect.
  useEffect(() => {
    if (connectGeneration === 0) return // never connected yet
    // First connect (generation 1) is initial mount, don't fire
    // onReconnect; subsequent generations are real reconnects.
    if (connectGeneration > 1 && connectGeneration !== lastGenerationRef.current) {
      onReconnectRef.current?.()
    }
    lastGenerationRef.current = connectGeneration
    // Re-emit subscribe after every reconnect — server doesn't
    // remember our subscriptions across socket drops.
    if (socket && Object.keys(eventsRef.current).length > 0) {
      socket.emit('subscribe', Object.keys(eventsRef.current))
    }
  }, [connectGeneration, socket])

  return {
    socket,
    connected: status === 'connected',
    status,
  }
}

/**
 * Status-only accessor. Use this in components that just need to
 * render based on connection state (the indicator dot in the
 * TopHeader, "live" badges, etc.) without registering any event
 * handlers.
 */
export function useWebSocketStatus(): ConnectionStatus {
  return useContext(WebSocketContext).status
}
