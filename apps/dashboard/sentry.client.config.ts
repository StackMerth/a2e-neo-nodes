// Sentry client-side init for the admin dashboard.
// Loaded in the browser. Captures unhandled errors, navigation, and
// fetch failures from React components.

import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Vercel sets VERCEL_GIT_COMMIT_SHA automatically; surface as the
    // release tag so Sentry groups errors by deploy.
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? undefined,
    // Filter out noise from browser extensions, ad blockers, etc.
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
    ],
  })
}
