'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'

// M5.7 polish: localStorage key shared between marketplace landing and
// portal /register so a ref code captured at marketplace.../?ref=CODE
// survives the user clicking through to portal signup. Both sides clear
// it after a successful signup. Domains are different, so this is just
// portal-side fallback for when the URL param gets dropped along the way
// (e.g. user lands on /signup chooser first, then clicks "Node Runner").
const REF_STORAGE_KEY = 'a2e_pending_ref'

export default function RegisterPage() {
  const { register } = useAuth()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isBuyer = searchParams.get('role') === 'buyer'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [referralCode, setReferralCode] = useState<string | null>(null)

  // Resolve referral code: URL param wins, localStorage is the fallback
  // for cases where the user navigated through /signup or refreshed.
  useEffect(() => {
    const urlRef = searchParams.get('ref')
    if (urlRef && /^[A-Z0-9]{4,16}$/i.test(urlRef)) {
      const code = urlRef.toUpperCase()
      setReferralCode(code)
      try { localStorage.setItem(REF_STORAGE_KEY, code) } catch { /* ignore */ }
      return
    }
    try {
      const stored = localStorage.getItem(REF_STORAGE_KEY)
      if (stored && /^[A-Z0-9]{4,16}$/.test(stored)) setReferralCode(stored)
    } catch { /* ignore */ }
  }, [searchParams])

  const validate = () => {
    const errs: Record<string, string> = {}
    if (!email) errs.email = 'Email is required'
    if (password.length < 8) errs.password = 'Password must be at least 8 characters'
    if (password !== confirmPassword) errs.confirmPassword = 'Passwords do not match'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setLoading(true)
    try {
      const role = isBuyer ? 'COMPUTE_BUYER' : 'NODE_RUNNER'
      const user = await register(email, password, role, referralCode ?? undefined)
      // Clear the stored code so a later signup on the same browser
      // doesn't accidentally re-attribute to the same referrer.
      try { localStorage.removeItem(REF_STORAGE_KEY) } catch { /* ignore */ }
      toast(
        'success',
        referralCode && !isBuyer
          ? `Account created. Referral ${referralCode} applied.`
          : 'Account created successfully',
      )
      if (user.role === 'COMPUTE_BUYER') {
        router.push('/buyer/dashboard')
      } else {
        router.push('/dashboard')
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">
        {isBuyer ? 'Create Buyer Account' : 'Create Account'}
      </h1>
      <p className="text-text-secondary text-sm mb-6">
        {isBuyer ? 'Get started with on-demand GPU compute' : 'Start earning with your GPU nodes'}
      </p>

      {/* M5.7 polish: surface the captured referral code so the user
          knows attribution will happen. Hidden when no code, or when
          this is a buyer signup since the program is operator-only. */}
      {referralCode && !isBuyer && (
        <div
          className="text-xs rounded-lg px-3 py-2 mb-4"
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.25)',
            color: 'var(--text-primary)',
          }}
        >
          Invited by <span className="font-mono">{referralCode}</span>. Your referrer earns 10 percent of your first 365 days of network earnings.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <Input
          label="Password"
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
        <Button type="submit" loading={loading} className="w-full">
          {isBuyer ? 'Create Buyer Account' : 'Create Account'}
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

      <Link href={isBuyer ? '/connect-wallet?role=buyer' : '/connect-wallet'}>
        <Button variant="secondary" className="w-full">
          Connect Wallet Instead
        </Button>
      </Link>

      <p className="text-sm text-text-muted text-center mt-4">
        {isBuyer ? (
          <>
            Want to run GPU nodes instead?{' '}
            <Link href="/register" className="text-accent hover:underline">
              Register as Node Runner
            </Link>
          </>
        ) : (
          <>
            Looking to buy compute?{' '}
            <Link href="/register?role=buyer" className="text-accent hover:underline">
              Register as Buyer
            </Link>
          </>
        )}
      </p>

      <p className="text-sm text-text-muted text-center mt-2">
        Already have an account?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}
