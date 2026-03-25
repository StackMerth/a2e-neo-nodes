'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { io, Socket } from 'socket.io-client'

const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e.byredstone.com'
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || 'a2e-dev-key-2026'

export interface SocketEvent {
  id: string
  type: string
  data: Record<string, unknown>
  timestamp: Date
}

interface NodeRegisteredEvent {
  nodeId: string
  walletAddress: string
  gpuTier: string
}

interface NodeOfflineEvent {
  nodeId: string
  walletAddress: string
  previousStatus: string
}

interface NodeHeartbeatEvent {
  nodeId: string
  status: string
  gpuUtilization?: number
  gpuTemperature?: number
}

interface JobRoutedEvent {
  jobId: string
  deploymentId: string
  market: string
  rate: number
  nodeId: string | null
  reason: string
}

interface JobFailedEvent {
  jobId: string
  error: string
  attemptsMade: number
  willRetry: boolean
}

interface RateUpdatedEvent {
  market: string
  gpuTier: string
  ratePerHour: number
  ratePerDay: number
}

export interface UseWebSocketReturn {
  connected: boolean
  events: SocketEvent[]
  lastEvent: SocketEvent | null
  clearEvents: () => void
  on: <T>(event: string, callback: (data: T) => void) => void
  off: (event: string) => void
}

export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false)
  const [events, setEvents] = useState<SocketEvent[]>([])
  const socketRef = useRef<Socket | null>(null)
  const listenersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map())

  useEffect(() => {
    // Initialize socket connection
    const socket = io(SOCKET_URL, {
      auth: { apiKey: API_KEY },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      addEvent('system', { message: 'Connected to A²E WebSocket' })
    })

    socket.on('disconnect', (reason) => {
      setConnected(false)
      addEvent('system', { message: `Disconnected: ${reason}` })
    })

    socket.on('connect_error', (error) => {
      addEvent('error', { message: `Connection error: ${error.message}` })
    })

    // Node events
    socket.on('node:registered', (data: NodeRegisteredEvent) => {
      addEvent('node:registered', data)
      notifyListeners('node:registered', data)
    })

    socket.on('node:offline', (data: NodeOfflineEvent) => {
      addEvent('node:offline', data)
      notifyListeners('node:offline', data)
    })

    socket.on('node:heartbeat', (data: NodeHeartbeatEvent) => {
      // Don't add heartbeats to event log (too noisy)
      notifyListeners('node:heartbeat', data)
    })

    // Job events
    socket.on('job:routed', (data: JobRoutedEvent) => {
      addEvent('job:routed', data)
      notifyListeners('job:routed', data)
    })

    socket.on('job:failed', (data: JobFailedEvent) => {
      addEvent('job:failed', data)
      notifyListeners('job:failed', data)
    })

    // Rate events
    socket.on('rate:updated', (data: RateUpdatedEvent) => {
      addEvent('rate:updated', data)
      notifyListeners('rate:updated', data)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  const addEvent = useCallback((type: string, data: object) => {
    const event: SocketEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      data: data as Record<string, unknown>,
      timestamp: new Date(),
    }
    setEvents((prev) => [event, ...prev].slice(0, 50)) // Keep last 50 events
  }, [])

  const notifyListeners = useCallback((event: string, data: unknown) => {
    const listeners = listenersRef.current.get(event)
    if (listeners) {
      listeners.forEach((callback) => callback(data))
    }
  }, [])

  const on = useCallback(<T,>(event: string, callback: (data: T) => void) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set())
    }
    listenersRef.current.get(event)!.add(callback as (data: unknown) => void)
  }, [])

  const off = useCallback((event: string) => {
    listenersRef.current.delete(event)
  }, [])

  const clearEvents = useCallback(() => {
    setEvents([])
  }, [])

  return {
    connected,
    events,
    lastEvent: events[0] || null,
    clearEvents,
    on,
    off,
  }
}

// Context provider for global socket access
import { createContext, useContext, ReactNode } from 'react'

const WebSocketContext = createContext<UseWebSocketReturn | null>(null)

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const socket = useWebSocket()
  return (
    <WebSocketContext.Provider value={socket}>
      {children}
    </WebSocketContext.Provider>
  )
}

export function useSocket() {
  const context = useContext(WebSocketContext)
  if (!context) {
    throw new Error('useSocket must be used within WebSocketProvider')
  }
  return context
}
