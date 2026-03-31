'use client'

import { useEffect } from 'react'
import { useSocket } from '@/hooks/useWebSocket'
import { useToast } from '@/components/ui/Toast'

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

interface JobRoutedEvent {
  jobId: string
  deploymentId: string
  market: string
  rate: number
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

export function WebSocketNotifier() {
  const { on, off, connected } = useSocket()
  const { addToast } = useToast()

  useEffect(() => {
    // Show connection status
    if (connected) {
      addToast({
        type: 'success',
        title: 'Connected',
        message: 'Real-time updates enabled',
      })
    }
  }, [connected, addToast])

  useEffect(() => {
    // Node registered
    on<NodeRegisteredEvent>('node:registered', (data) => {
      addToast({
        type: 'success',
        title: 'Node Registered',
        message: `${data.gpuTier} node added (${data.walletAddress.slice(0, 10)}...)`,
      })
    })

    // Node offline
    on<NodeOfflineEvent>('node:offline', (data) => {
      addToast({
        type: 'warning',
        title: 'Node Offline',
        message: `Node ${data.walletAddress.slice(0, 10)}... went offline`,
      })
    })

    // Job routed
    on<JobRoutedEvent>('job:routed', (data) => {
      addToast({
        type: 'info',
        title: 'Job Routed',
        message: `${data.deploymentId} → ${data.market} ($${(data.rate * 24).toFixed(2)}/day)`,
      })
    })

    // Job failed
    on<JobFailedEvent>('job:failed', (data) => {
      addToast({
        type: 'error',
        title: 'Job Failed',
        message: data.willRetry ? `Retrying... (attempt ${data.attemptsMade})` : data.error,
      })
    })

    // Rate updates are silent - they happen frequently and would be noisy
    // The rates page will show current values

    return () => {
      off('node:registered')
      off('node:offline')
      off('job:routed')
      off('job:failed')
    }
  }, [on, off, addToast])

  // This component doesn't render anything
  return null
}
