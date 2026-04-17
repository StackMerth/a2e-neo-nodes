'use client'

import { useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'

function ResetPasswordContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const validate = () => {
    const errs: Record<string, string> = {}
    if (password.length < 8) errs.password = 'Password must be at least 8 characters'
    if (password !== confirmPassword) errs.confirmPassword = 'Passwords do not match'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setLoading(true)
    setErrors({})

    try {
      await apiFetch('/v1/portal/auth/reset-password', {
        method: 'POST',
        body: { token, password },
      })
      setSuccess(true)
    } catch (err) {
      setErrors({
        form: err instanceof Error ? err.message : 'Reset failed. The link may have expired.',
      })
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <Card className="p-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Invalid Link</h1>
          <p className="text-text-secondary text-sm">Missing reset token. Please request a new password reset.</p>
          <Link
            href="/forgot-password"
            className="mt-2 text-accent hover:underline text-sm font-medium"
          >
            Request New Link
          </Link>
        </div>
      </Card>
    )
  }

  if (success) {
    return (
      <Card className="p-8 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-accent/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Password Reset</h1>
          <p className="text-text-secondary text-sm">Your password has been reset successfully. You can now log in.</p>
          <Link
            href="/login"
            className="mt-2 text-accent hover:underline text-sm font-medium"
          >
            Go to Login
          </Link>
        </div>
      </Card>
    )
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Reset Password</h1>
      <p className="text-text-secondary text-sm mb-6">
        Enter your new password below.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="New Password"
          type="password"
          placeholder="At least 8 characters"
          value={password}
          onChange={e => setPassword(e.target.value)}
          error={errors.password}
          required
        />
        <Input
          label="Confirm Password"
          type="password"
          placeholder="Repeat your password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          error={errors.confirmPassword}
          required
        />

        {errors.form && (
          <p className="text-sm text-error">{errors.form}</p>
        )}

        <Button type="submit" loading={loading} className="w-full">
          Reset Password
        </Button>
      </form>

      <p className="text-sm text-text-muted text-center mt-6">
        Remember your password?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}

export default function ResetPasswordPage() {
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
      <ResetPasswordContent />
    </Suspense>
  )
}
