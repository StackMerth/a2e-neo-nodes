'use client'

/**
 * Browser web push toggle (VAPID). Subscribes the current device to
 * receive OS-level notifications for the same events that already
 * fire in-app + email (NODE_OFFLINE, PAYOUT_SENT, COMPUTE_ACTIVE,
 * etc.). Per-device — connecting from a different browser or the
 * installed PWA requires a separate opt-in.
 *
 * Reusable between the node-runner Settings page and the buyer
 * Settings page so both audiences get the same control surface.
 */

import { BellRing, BellOff } from 'lucide-react'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { FormCard, FormSection } from '@/components/dashboard/FuturisticShell'

export function PushNotificationsCard() {
  const { toast } = useToast()
  const { permission, configured, subscribed, phase, subscribe, unsubscribe } = usePushNotifications()

  async function handleToggle() {
    try {
      if (subscribed) {
        await unsubscribe()
        toast('success', 'Browser notifications turned off for this device.')
      } else {
        await subscribe()
        toast('success', 'Browser notifications on. You\'ll get a ping for important events.')
      }
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not change notification setting')
    }
  }

  const unsupported = permission === 'unsupported'
  const denied = permission === 'denied'
  const backendOff = configured === false
  const disabled = unsupported || backendOff || phase !== 'idle'

  const blocker = unsupported
    ? 'This browser does not support web push.'
    : backendOff
      ? 'Web push is not configured on this server. Contact support.'
      : denied
        ? 'You denied notification permission previously. Re-enable it in your browser site-settings, then come back.'
        : null

  return (
    <FormCard
      title="Browser notifications"
      description="OS-level alerts for important events (compute ready, payout sent, node offline). Per-device opt-in."
      icon={subscribed ? BellRing : BellOff}
    >
      <FormSection>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {subscribed ? 'Browser notifications are on for this device' : 'Enable browser notifications on this device'}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {subscribed
                ? 'You\'ll receive a system notification for important events even when the tab is closed. Click Turn off to stop.'
                : 'You\'ll get a system notification for important events even when this tab is closed. We\'ll ask your browser for permission first.'}
            </p>
            {blocker && (
              <p className="text-xs mt-2" style={{ color: 'var(--warning, #f59e0b)' }}>
                {blocker}
              </p>
            )}
          </div>
          <Button
            onClick={handleToggle}
            disabled={disabled}
            variant={subscribed ? 'secondary' : 'primary'}
            size="sm"
            loading={phase !== 'idle'}
          >
            {subscribed ? 'Turn off' : 'Enable'}
          </Button>
        </div>
      </FormSection>
    </FormCard>
  )
}
