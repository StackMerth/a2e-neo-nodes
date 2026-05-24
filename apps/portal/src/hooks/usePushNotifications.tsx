'use client'

/**
 * Hook that wraps the browser PushManager + the portal /push API
 * into a single subscribe / unsubscribe / status surface for the
 * Settings UI to consume.
 *
 * Flow when the user opts in:
 *   1. Request Notification.permission (browser native prompt).
 *   2. Fetch the VAPID public key from the API.
 *   3. Subscribe via the service worker's PushManager.
 *   4. POST { endpoint, keys } to /v1/portal/push/subscribe.
 *
 * Unsubscribe reverses 3-4. Permission tracking + service-worker
 * readiness checks happen up-front so the UI can disable the toggle
 * gracefully on incompatible browsers (iOS Safari < 16.4, no SW, etc.).
 */

import { useCallback, useEffect, useState } from 'react'
import { auth, apiFetch } from '@/lib/api'

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported'
type PushPhase = 'idle' | 'subscribing' | 'unsubscribing'

interface UsePushNotificationsState {
  permission: PermissionState
  configured: boolean | null   // true if the API has VAPID keys; null while loading
  subscribed: boolean
  phase: PushPhase
}

// Decode a base64url-encoded VAPID public key into a Uint8Array for
// the browser PushManager. Built-in atob does base64; we polyfill
// URL-safe variant here.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function usePushNotifications(): UsePushNotificationsState & {
  subscribe: () => Promise<void>
  unsubscribe: () => Promise<void>
  refresh: () => Promise<void>
} {
  const [permission, setPermission] = useState<PermissionState>('default')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [phase, setPhase] = useState<PushPhase>('idle')

  const refresh = useCallback(async () => {
    // Permission state from the browser API.
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPermission('unsupported')
      setConfigured(false)
      setSubscribed(false)
      return
    }
    setPermission(Notification.permission as PermissionState)

    // Backend configured? + this user already subscribed?
    try {
      const status = await apiFetch<{ configured: boolean; subscribed: boolean; count: number }>(
        '/v1/portal/push/status',
      )
      setConfigured(status.configured)
      setSubscribed(status.subscribed)
    } catch {
      setConfigured(false)
      setSubscribed(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const subscribe = useCallback(async () => {
    if (typeof window === 'undefined') return
    if (permission === 'unsupported') return

    setPhase('subscribing')
    try {
      // Step 1: ask the browser for permission. Will be a no-op if
      // the user previously granted; will throw / return 'denied'
      // if they previously denied (browsers do not allow re-prompts).
      const result = await Notification.requestPermission()
      setPermission(result as PermissionState)
      if (result !== 'granted') throw new Error('Notification permission was denied. Enable it in your browser settings to re-enable.')

      // Step 2: fetch the VAPID public key from the API.
      const keyRes = await apiFetch<{ configured: boolean; publicKey?: string; error?: string }>(
        '/v1/portal/push/public-key',
      )
      if (!keyRes.configured || !keyRes.publicKey) {
        throw new Error('Web Push is not configured on this deploy.')
      }

      // Step 3: subscribe via the service-worker PushManager.
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      // applicationServerKey expects a BufferSource. Slice the buffer
      // out of the Uint8Array view to satisfy strict TS's ArrayBuffer
      // vs SharedArrayBuffer distinction.
      const keyBytes = urlBase64ToUint8Array(keyRes.publicKey)
      const sub = existing ?? (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer.slice(0) as ArrayBuffer,
      }))

      // Step 4: POST to /v1/portal/push/subscribe so the server can
      // route future pushes to this endpoint.
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
      await apiFetch('/v1/portal/push/subscribe', {
        method: 'POST',
        body: { endpoint: json.endpoint, keys: json.keys },
      })

      setSubscribed(true)
    } finally {
      setPhase('idle')
    }
  }, [permission])

  const unsubscribe = useCallback(async () => {
    if (typeof window === 'undefined') return
    setPhase('unsubscribing')
    try {
      const registration = await navigator.serviceWorker.ready
      const sub = await registration.pushManager.getSubscription()
      if (sub) {
        await apiFetch('/v1/portal/push/unsubscribe', {
          method: 'POST',
          body: { endpoint: sub.endpoint },
        })
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } finally {
      setPhase('idle')
    }
  }, [])

  // Suppress unused import warning — auth re-exported via lib/api for
  // call sites that need the full surface, kept here for hook ergonomics.
  void auth

  return { permission, configured, subscribed, phase, subscribe, unsubscribe, refresh }
}
