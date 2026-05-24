/**
 * Web Push (VAPID) sender. Reads keys from env, sends encrypted
 * payloads to the Push Service URLs registered by each user.
 *
 * VAPID keys are generated once (offline) via:
 *   pnpm --filter @a2e/api exec node -e "console.log(require('web-push').generateVAPIDKeys())"
 * and stored as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars on
 * the Render API service. VAPID_SUBJECT must be a mailto: URL or a
 * URL that identifies the sending org per RFC 8292.
 *
 * The public key is also exposed to the frontend via
 * GET /v1/portal/push/public-key so the service worker can
 * subscribe each browser.
 *
 * Send failures cascade by error class:
 *   404 / 410 Gone  -> endpoint is dead; delete the subscription
 *   other         -> log + leave subscription in place for retry
 */

import webpush from 'web-push'
import { prisma } from '@a2e/database'

let configured = false

export function isPushConfigured(): boolean {
  if (configured) return true
  const pub = process.env.VAPID_PUBLIC_KEY?.trim()
  const priv = process.env.VAPID_PRIVATE_KEY?.trim()
  const subj = process.env.VAPID_SUBJECT?.trim()
  if (!pub || !priv || !subj) return false
  try {
    webpush.setVapidDetails(subj, pub, priv)
    configured = true
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[push] VAPID key configuration failed:', (err as Error).message)
    return false
  }
}

export function getPushPublicKey(): string | null {
  if (!isPushConfigured()) return null
  return process.env.VAPID_PUBLIC_KEY?.trim() ?? null
}

export interface PushPayload {
  title: string
  body: string
  // Deep-link URL the service worker opens when the user clicks
  // the notification. Falls back to the portal root.
  url?: string
  // Optional notification icon override. Defaults to the PWA icon.
  icon?: string
  // Optional badge (the monochrome icon shown in the status bar on
  // Android). Defaults to the PWA badge.
  badge?: string
  // Tag groups stacked notifications; same tag replaces a previous
  // one on most platforms. Defaults to the notification type so
  // a flood of compute:tick events does not pile up.
  tag?: string
}

/**
 * Send a push to every active subscription for the given user.
 * No-ops cleanly when push is not configured or the user has no
 * subscribed devices.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!isPushConfigured()) {
    return { sent: 0, pruned: 0 }
  }

  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  })
  if (subs.length === 0) return { sent: 0, pruned: 0 }

  // Web Push payload is small (4KB cap). Stringify once + reuse.
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    icon: payload.icon ?? '/icon-192.png',
    badge: payload.badge ?? '/icon-192.png',
    tag: payload.tag,
  })

  let sent = 0
  let pruned = 0
  const deadIds: string[] = []
  const sentIds: string[] = []

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        )
        sent += 1
        sentIds.push(s.id)
      } catch (err) {
        // web-push errors expose a numeric statusCode on most failures.
        const status = (err as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          // Subscription is permanently gone. Prune it so the next
          // send does not waste a round-trip.
          deadIds.push(s.id)
          pruned += 1
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[push] send failed userId=${userId} status=${status ?? 'n/a'}`, (err as Error).message)
        }
      }
    }),
  )

  if (deadIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: deadIds } } })
  }
  if (sentIds.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: sentIds } },
      data: { lastSentAt: new Date() },
    })
  }

  return { sent, pruned }
}
