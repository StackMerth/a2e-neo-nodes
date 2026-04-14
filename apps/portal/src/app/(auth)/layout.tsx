'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()

  // Redirect to dashboard if already logged in
  useEffect(() => {
    if (!loading && user) {
      router.push('/dashboard')
    }
  }, [user, loading, router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    )
  }

  if (user) return null

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <Link href="/" className="mb-8 flex items-center gap-2">
        <span className="text-3xl font-bold gradient-text">A²E</span>
        <span className="text-lg text-text-muted">Portal</span>
      </Link>
      <div className="w-full max-w-md">
        {children}
      </div>
      <p className="mt-8 text-sm text-text-muted">
        &copy; {new Date().getFullYear()} TokenOS &mdash; Decentralized GPU Compute
      </p>
    </div>
  )
}
