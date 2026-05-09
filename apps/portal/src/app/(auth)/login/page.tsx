'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'

export default function LoginPage() {
  const { login } = useAuth()
  const { toast } = useToast()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const user = await login(email, password)
      toast('success', 'Logged in successfully')
      if (user.role === 'COMPUTE_BUYER') {
        router.push('/buyer/dashboard')
      } else {
        router.push('/dashboard')
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Welcome Back</h1>
      <p className="text-text-secondary text-sm mb-2">
        Sign in to your A²E account
      </p>
      <p className="text-text-muted text-xs mb-6">
        One sign-in for everyone. We&apos;ll route you to the right dashboard automatically:
        node runners go to GPU management, compute buyers go to rentals.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <div>
          <Input
            label="Password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={e => setPassword(e.target.value)}
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

      <div className="mt-6 pt-6 border-t border-border space-y-2 text-center">
        <p className="text-sm text-text-muted">Don&apos;t have an account yet?</p>
        <div className="flex flex-col gap-1.5 text-sm">
          <Link href="/register" className="text-accent hover:underline">
            Sign up as Node Runner
          </Link>
          <span className="text-text-muted text-xs">earn by hosting GPUs</span>
          <Link href="/register?role=buyer" className="text-accent hover:underline mt-1">
            Sign up as Compute Buyer
          </Link>
          <span className="text-text-muted text-xs">rent GPUs for AI workloads</span>
        </div>
      </div>
    </Card>
  )
}
