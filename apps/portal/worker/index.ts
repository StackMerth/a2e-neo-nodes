/// <reference lib="webworker" />
/**
 * Custom service-worker additions for the portal PWA. next-pwa
 * compiles this and prepends it to the generated workbox sw.js,
 * so push + notificationclick handlers live alongside the default
 * caching strategies.
 *
 * Payload shape sent by the API (services/notification/push.ts):
 *   { title, body, url?, icon?, badge?, tag? }
 *
 * tag groups stacked notifications so a burst of compute:tick or
 * similar events does not flood the system tray.
 */

// Service-worker self handle. The bare `self` in this scope resolves
// to globalThis under tsc which doesn't include ServiceWorkerGlobalScope
// in its event map, so we cast once and use the typed handle below.
const sw = self as unknown as ServiceWorkerGlobalScope

interface PushPayload {
  title: string
  body: string
  url?: string
  icon?: string
  badge?: string
  tag?: string
}

sw.addEventListener('push', (event: PushEvent) => {
  let payload: PushPayload
  try {
    payload = event.data ? (event.data.json() as PushPayload) : { title: 'TokenOS_DeAI', body: 'You have a new update.' }
  } catch {
    // Bad payload — show a generic notification so the user knows
    // SOMETHING happened rather than dropping the event silently.
    payload = { title: 'TokenOS_DeAI', body: event.data?.text() ?? 'New update.' }
  }

  // renotify is a valid Notifications API field per the spec but
  // not yet in TS's NotificationOptions lib; cast through any.
  const options = {
    body: payload.body,
    icon: payload.icon ?? '/icon-192.png',
    badge: payload.badge ?? '/icon-192.png',
    tag: payload.tag,
    // Re-fire the OS notification chrome when a new payload with the
    // same tag arrives, so a re-notification feels live rather than
    // being silently swapped under the previous one.
    renotify: !!payload.tag,
    // Store the deep-link URL on the notification so the
    // notificationclick handler below can route the user there.
    data: { url: payload.url ?? '/' },
  } as NotificationOptions

  event.waitUntil(sw.registration.showNotification(payload.title, options))
})

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const target: string = (event.notification.data?.url as string | undefined) ?? '/'

  event.waitUntil(
    (async () => {
      // Try to focus an existing portal tab if one is already open
      // (PWA standalone counts too). Falls back to opening a new
      // window pointed at the deep-link URL.
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clients) {
        if (client.url.includes(sw.location.origin) && 'focus' in client) {
          if (target && 'navigate' in client) {
            await (client as WindowClient).navigate(target).catch(() => {})
          }
          await (client as WindowClient).focus()
          return
        }
      }
      await sw.clients.openWindow(target)
    })(),
  )
})
