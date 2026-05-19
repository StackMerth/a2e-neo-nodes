import type { MetadataRoute } from 'next'

/**
 * C6 wave 2: PWA manifest. Served at /manifest.webmanifest by Next's
 * metadata route. Lets operators on mobile "Add to Home Screen" and
 * launch the portal in a standalone window with the TokenOS icon.
 *
 * start_url points at /dashboard so launches drop them straight into
 * the operator view; pure buyers still get auto-redirected from there
 * if they need it. theme_color matches the portal's primary green.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
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
  }
}
