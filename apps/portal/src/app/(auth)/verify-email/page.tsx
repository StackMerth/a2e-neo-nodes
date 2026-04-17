'use client'

import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { Card } from '@/components/ui/Card'

function VerifyEmailContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage('Missing verification token. Please check your email link.')
      return
    }

    async function verify() {
      try {
        await apiFetch('/v1/portal/auth/verify-email', {
          method: 'POST',
          body: { token },
        })
        setStatus('success')
        setMessage('Your email has been verified! You can close this page.')
      } catch (err) {
        setStatus('error')
        setMessage(err instanceof Error ? err.message : 'Verification failed. The link may have expired.')
      }
    }

    verify()
  }, [token])

  return (
    <Card className="p-8 text-center">
      {status === 'loading' && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-text-secondary text-sm">Verifying your email...</p>
        </div>
      )}

      {status === 'success' && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Email Verified</h1>
          <p className="text-text-secondary text-sm">{message}</p>
          <Link
            href="/login"
            className="mt-2 text-accent hover:underline text-sm font-medium"
          >
            Go to Login
          </Link>
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Verification Failed</h1>
          <p className="text-text-secondary text-sm">{message}</p>
          <Link
            href="/login"
            className="mt-2 text-accent hover:underline text-sm font-medium"
          >
            Go to Login
          </Link>
        </div>
      )}
    </Card>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <Card className="p-8 text-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <p className="text-text-secondary text-sm">Loading...</p>
          </div>
        </Card>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  )
}
