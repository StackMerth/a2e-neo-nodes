import type { MetadataRoute } from 'next'

/**
 * C6 wave 2: PWA manifest. Served at /manifest.webmanifest by Next's
 * metadata route. Lets operators on mobile "Add to Home Screen" and
 * launch the portal in a standalone window with the TokenOS icon.
 *
 * start_url points at /dashboard so launches drop them straight into
 * the operator view; pure buyers still get auto-redirected from there
 * if they need it. theme_color matches the portal's primary green.
 *
 * `id` is set explicitly so Chrome's app identity stays anchored to
 * /dashboard even if start_url or path conventions change later.
 * Without it the DevTools Manifest panel warns 'id is not specified'
 * and falls back to start_url, which makes the app re-identify as a
 * different PWA across deploys if either changes.
 *
 * `screenshots` with form_factor=narrow unlocks the richer install
 * UI Chrome shows on Android — a carousel of preview shots in the
 * install bottom-sheet. With form_factor=wide they show up on the
 * desktop install prompt. We point at /screenshot/* paths; matching
 * PNGs live in apps/portal/public/screenshots/ (placeholder dark
 * canvases for now; can be swapped for real captures later without
 * code changes).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/dashboard',
    name: 'TokenOS DeAI Portal',
    short_name: 'TokenOS',
    description: 'Manage your GPU node and rentals on the TokenOS DeAI network.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#0a0a0f',
    theme_color: '#22c55e',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    // Next's MetadataRoute.Manifest.screenshots type omits form_factor
    // and label, but the actual web app manifest spec accepts them and
    // Chrome reads them. Cast through unknown so we ship the richer
    // install dialog metadata; Next emits the JSON faithfully.
    screenshots: [
      {
        src: '/screenshots/mobile-dashboard.png',
        sizes: '750x1334',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Operator dashboard',
      },
      {
        src: '/screenshots/desktop-dashboard.png',
        sizes: '1280x800',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Operator dashboard on desktop',
      },
    ] as unknown as MetadataRoute.Manifest['screenshots'],
  }
}
