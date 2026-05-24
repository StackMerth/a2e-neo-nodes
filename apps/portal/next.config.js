/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // basePath was '/portal' in Phase 1 because the original deployment served
  // both dashboard and portal under different paths on a single domain.
  // On its own Vercel subdomain, the portal needs to serve at the root, so
  // the basePath is removed. Re-add it (and set NEXT_PUBLIC_BASE_PATH=/portal
  // in env) only if you go back to a path-multiplexed deployment.
  //
  // output: 'standalone' was removed because Vercel does its own bundling
  // and ignores the setting, and standalone mode triggers EPERM symlink
  // errors on Windows local builds. The portal has never been Dockerized,
  // so dropping it is risk-free.
}

// C6 wave 2: PWA wrap. Operators on phones can install the portal to
// their home screen and launch it in standalone mode (no browser
// chrome). Service worker is disabled in development so the usual hot-
// reload loop doesn't get hijacked by cached responses.
//
// fallbacks.document routes any uncached navigation request (e.g. a
// fresh visit to /earnings while offline) to /offline.html. Without
// this, next-pwa's default Workbox runtime cache only serves pages the
// user has already visited; everything else returns the browser's
// generic "This site can't be reached" error inside the installed PWA.
const withPWA = require('@ducanh2912/next-pwa').default({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  fallbacks: {
    document: '/offline',
  },
  // Custom service-worker code (push + notificationclick handlers)
  // lives in ./worker/index.ts. next-pwa compiles it and prepends
  // it to the generated workbox sw.js at build time.
  customWorkerSrc: 'worker',
})

module.exports = withPWA(nextConfig)
