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

interface ComputeRequestNewEvent {
  requestId: string
  userId: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  totalCost: number
}

interface ComputeWaitlistedEvent {
  requestId: string
  userId: string
  flags: string[]
}

interface ComputeAllocatedEvent {
  requestId: string
  userId: string
  nodeIds: string[]
}

interface ComputeTerminatedEvent {
  requestId: string
  userId: string
  gpuTier?: string
  gpuCount?: number
  refundAmount: number
  refundStatus: string
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

    // M2: compute lifecycle. Loud for new buyer requests (admin should
    // notice immediately), quieter for downstream transitions.
    on<ComputeRequestNewEvent>('compute:request:new', (data) => {
      addToast({
        type: 'info',
        title: 'New Compute Request',
        message: `${data.gpuCount}x ${data.gpuTier} for ${data.durationDays}d ($${data.totalCost.toFixed(0)})`,
      })
    })

    on<ComputeWaitlistedEvent>('compute:waitlisted', (data) => {
      const holdCount = data.flags.filter(f => f.startsWith('HOLD_')).length
      addToast({
        type: 'warning',
        title: 'Request Held for Review',
        message: `${holdCount} eligibility flag${holdCount === 1 ? '' : 's'} — see Compute > Needs Review`,
      })
    })

    on<ComputeAllocatedEvent>('compute:allocated', (data) => {
      addToast({
        type: 'success',
        title: 'Compute Allocated',
        message: `${data.nodeIds.length} node${data.nodeIds.length === 1 ? '' : 's'} assigned`,
      })
    })

    on<ComputeTerminatedEvent>('compute:terminated', (data) => {
      // Distinguish the two completion paths so admin sees what
      // actually happened: buyer-initiated terminate vs auto-expiry.
      const isAutoExpiry = data.refundStatus === 'SKIPPED_FULL_TERM'
      const tier = data.gpuTier ? `${data.gpuCount ?? 1}x ${data.gpuTier}` : 'rental'
      addToast({
        type: isAutoExpiry ? 'info' : 'warning',
        title: isAutoExpiry ? 'Rental Auto-Completed' : 'Rental Terminated',
        message: isAutoExpiry
          ? `${tier} reached end of term`
          : `${tier} terminated early — refund $${data.refundAmount.toFixed(2)} (${data.refundStatus})`,
      })
    })

    return () => {
      off('node:registered')
      off('node:offline')
      off('job:routed')
      off('job:failed')
      off('compute:request:new')
      off('compute:waitlisted')
      off('compute:allocated')
      off('compute:terminated')
    }
  }, [on, off, addToast])

  // This component doesn't render anything
  return null
}
