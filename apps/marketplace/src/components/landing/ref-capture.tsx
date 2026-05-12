'use client'

/*
 * M5.7 polish: read ?ref=CODE off the marketplace URL when a user
 * arrives via a share link, persist it to localStorage, and rewrite
 * the visible href on every CTA that points at the portal signup so
 * the code propagates across the marketplace -> portal handoff (two
 * different domains, so localStorage alone does not bridge it).
 *
 * The component is a pure side-effect client component: it renders
 * nothing. Mount it once in the marketplace root layout.
 */

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

const REF_STORAGE_KEY = 'a2e_pending_ref'
const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://a2e-user.stackforgelab.tech'

export function RefCapture() {
  const searchParams = useSearchParams()

  useEffect(() => {
    // 1. Read ?ref= and validate the alphabet/length so we never
    //    persist something nonsensical.
    const urlRef = searchParams.get('ref')
    let resolved: string | null = null
    if (urlRef && /^[A-Z0-9]{4,16}$/i.test(urlRef)) {
      resolved = urlRef.toUpperCase()
      try { localStorage.setItem(REF_STORAGE_KEY, resolved) } catch { /* ignore */ }
    } else {
      try {
        const stored = localStorage.getItem(REF_STORAGE_KEY)
        if (stored && /^[A-Z0-9]{4,16}$/.test(stored)) resolved = stored
      } catch { /* ignore */ }
    }

    if (!resolved) return

    // 2. Rewrite every <a> that targets the portal signup or register
    //    page so the ref code rides along across the domain hop.
    //    Skipping links that already carry a ref so we never overwrite
    //    an explicit value the user typed.
    const code = resolved
    const targetHosts = new Set<string>()
    try {
      targetHosts.add(new URL(PORTAL_URL).host)
    } catch { /* PORTAL_URL malformed; skip */ }

    function rewriteLinks() {
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]')
      anchors.forEach(a => {
        const raw = a.getAttribute('href')
        if (!raw) return
        let url: URL
        try {
          url = new URL(raw, window.location.origin)
        } catch {
          return
        }
        const isPortalHost = targetHosts.has(url.host)
        const isAuthPath = /\/(signup|register|login|connect-wallet)(\/|$|\?)/.test(url.pathname)
        if (!isPortalHost || !isAuthPath) return
        if (url.searchParams.has('ref')) return
        url.searchParams.set('ref', code)
        a.setAttribute('href', url.toString())
      })
    }

    rewriteLinks()

    // Hero/CTA buttons hydrate after first paint and the existing
    // animation utilities can re-mount sections, so we re-apply on a
    // short cadence for a couple of seconds before settling.
    const interval = window.setInterval(rewriteLinks, 500)
    const stop = window.setTimeout(() => window.clearInterval(interval), 4000)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(stop)
    }
  }, [searchParams])

  return null
}
