'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Settlements are managed inside the Financial Overview page.
// This route exists so direct links to /settlements don't 404.
export default function SettlementsRedirect() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/financial#settlements')
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-dark)' }}>
      <div className="flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
        <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#22c55e' }} />
        <span className="text-sm">Redirecting to Financial Overview...</span>
      </div>
    </div>
  )
}
