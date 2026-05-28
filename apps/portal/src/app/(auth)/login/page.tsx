'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, Info } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'

/**
 * Translate whatever the API/network layer threw into a clear,
 * user-facing message. We intentionally collapse "user not found" and
 * "wrong password" into a single "Email or password is incorrect"
 * string — exposing which one is wrong leaks valid emails to anyone
 * probing the form, which is the standard email-enumeration attack.
 */
function humanizeLoginError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const lower = raw.toLowerCase()
  if (lower.includes('invalid email') || lower.includes('unauthorized') || lower.includes('401')) {
    return 'Email or password is incorrect.'
  }
  if (lower.includes('too many') || lower.includes('rate limit') || lower.includes('429')) {
    return 'Too many sign-in attempts. Please wait a minute and try again.'
  }
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('failed')) {
    return "Couldn't reach the server. Check your internet connection and try again."
  }
  return raw || 'Sign in failed. Please try again.'
}

export default function LoginPage() {
  const { login } = useAuth()
  const { toast } = useToast()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // iOS sandboxes a home-screen PWA's storage separately from Safari,
  // so a user who was signed in via Safari and then "Add to Home
  // Screen" lands here logged out on first launch. Surface a small
  // notice in that exact case so they don't think it's a bug.
  const [iosPwaFirstLaunch, setIosPwaFirstLaunch] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const ua = window.navigator.userAgent
    const isIos = /iPhone|iPad|iPod/.test(ua)
    const isStandalone =
      (window.navigator as { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches
    setIosPwaFirstLaunch(isIos && isStandalone)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      // Normalize before sending so a stray space or a mobile auto-
      // capitalized first letter can't desync from how registerUser
      // stored the email. The server normalizes too as a second line
      // of defense.
      const normalizedEmail = email.trim().toLowerCase()
      const user = await login(normalizedEmail, password)
      toast('success', 'Logged in successfully')
      if (user.role === 'COMPUTE_BUYER') {
        router.push('/buyer/dashboard')
      } else {
        router.push('/dashboard')
      }
    } catch (err) {
      const message = humanizeLoginError(err)
      // Inline error stays visible until the user re-types. Toast adds
      // a screen-reader-friendly announcement and a second visual cue
      // for users who don't notice the inline message.
      setError(message)
      toast('error', message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Welcome Back</h1>
      <p className="text-text-secondary text-sm mb-6">Sign in to your TokenOS DeAI account</p>

      {iosPwaFirstLaunch && (
        <div
          role="note"
          className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5"
          style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)' }}
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--info, #3b82f6)' }} />
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            iOS stores home-screen apps separately from Safari. Sign in once here and you&rsquo;ll stay logged in for future launches.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2.5"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}
        <Input
          label="Email"
          type="email"
          inputMode="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => {
            setEmail(e.target.value)
            if (error) setError(null)
          }}
          error={error ? ' ' : undefined}
          required
        />
        <div>
          <Input
            label="Password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={e => {
              setPassword(e.target.value)
              if (error) setError(null)
            }}
            error={error ? ' ' : undefined}
            required
          />
          <div className="mt-1.5 text-right">
            <Link href="/forgot-password" className="text-sm text-accent hover:underline">
              Forgot password?
            </Link>
          </div>
        </div>
        <Button type="submit" loading={loading} className="w-full">
          Sign In
        </Button>
      </form>

      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="px-2 bg-surface text-text-muted">or</span>
        </div>
      </div>

      <Link href="/connect-wallet">
        <Button variant="secondary" className="w-full">
          <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 18v1a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1" />
            <path d="M15 12a3 3 0 100-6 3 3 0 000 6z" />
          </svg>
          Connect Wallet
        </Button>
      </Link>

      <p className="text-sm text-text-muted text-center mt-6">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-accent hover:underline">
          Sign up
        </Link>
      </p>
    </Card>
  )
}
