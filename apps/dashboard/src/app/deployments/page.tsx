'use client'

/**
 * /deployments was the operator-self-service deployment workflow page.
 * It has been consolidated into /investments — both pages were
 * showing the same Investment rows, and the dual entry points were
 * confusing admins more than they were helping.
 *
 * /investments now carries both action paths per row:
 *   - Install:           admin pastes the curl one-liner via their
 *                        own SSH session
 *   - Add SSH & Deploy:  admin provides SSH credentials and the
 *                        provision-job worker installs remotely
 *
 * This page exists only to redirect any bookmarks / sidebar links
 * that still point here.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function DeploymentsRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/investments')
  }, [router])
  return null
}
