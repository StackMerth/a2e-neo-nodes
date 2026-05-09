'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ArrowRight, Cpu, Mail, Server, Wallet } from 'lucide-react'
import { Card } from '@/components/ui/Card'

type Role = 'node-runner' | 'buyer' | null

export default function SignupPage() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const roleParam = searchParams.get('role')
  const role: Role =
    roleParam === 'buyer' ? 'buyer' : roleParam === 'node-runner' ? 'node-runner' : null

  if (role === null) {
    return <RoleChooser />
  }
  return <AuthMethodPicker role={role} onBack={() => router.push('/signup')} />
}

function RoleChooser() {
  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Create your account</h1>
      <p className="text-text-secondary text-sm mb-6">What are you signing up for?</p>

      <div className="space-y-3">
        <Link
          href="/signup?role=node-runner"
          className="block group"
          aria-label="Sign up as Node Runner"
        >
          <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-surface-hover hover:border-accent/40 transition-all duration-200">
            <div className="w-11 h-11 flex-shrink-0 rounded-lg flex items-center justify-center bg-accent/10">
              <Server className="w-5 h-5 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary mb-0.5">Node Runner</p>
              <p className="text-sm text-text-muted">
                Earn by hosting your GPUs on the A²E network
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all" />
          </div>
        </Link>

        <Link
          href="/signup?role=buyer"
          className="block group"
          aria-label="Sign up as Compute Buyer"
        >
          <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-surface-hover hover:border-accent/40 transition-all duration-200">
            <div className="w-11 h-11 flex-shrink-0 rounded-lg flex items-center justify-center bg-accent/10">
              <Cpu className="w-5 h-5 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary mb-0.5">Compute Buyer</p>
              <p className="text-sm text-text-muted">
                Rent GPUs for AI workloads, training, inference, render
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all" />
          </div>
        </Link>
      </div>

      <p className="text-sm text-text-muted text-center mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}

function AuthMethodPicker({ role, onBack }: { role: 'node-runner' | 'buyer'; onBack: () => void }) {
  const isBuyer = role === 'buyer'
  const heading = isBuyer ? 'Sign up as Compute Buyer' : 'Sign up as Node Runner'
  const subline = isBuyer
    ? 'Rent GPUs for AI workloads, training, inference, render'
    : 'Earn by hosting your GPUs on the A²E network'
  const emailHref = isBuyer ? '/register?role=buyer' : '/register'
  const walletHref = isBuyer ? '/connect-wallet?role=buyer' : '/connect-wallet'

  return (
    <Card className="p-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <h1 className="text-2xl font-bold text-text-primary mb-2">{heading}</h1>
      <p className="text-text-secondary text-sm mb-6">{subline}</p>

      <div className="space-y-3">
        <Link href={emailHref} className="block group" aria-label="Sign up with email">
          <div className="flex items-center gap-4 p-4 rounded-xl border border-border bg-surface-hover hover:border-accent/40 transition-all duration-200">
            <div className="w-11 h-11 flex-shrink-0 rounded-lg flex items-center justify-center bg-accent/10">
              <Mail className="w-5 h-5 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary mb-0.5">Sign up with email</p>
              <p className="text-sm text-text-muted">Use an email and password</p>
            </div>
            <ArrowRight className="w-5 h-5 text-text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all" />
          </div>
        </Link>

        <Link href={walletHref} className="block group" aria-label="Sign up with wallet">
          <div className="flex items-center gap-4 p-4 rounded-xl border border-border bg-surface-hover hover:border-accent/40 transition-all duration-200">
            <div className="w-11 h-11 flex-shrink-0 rounded-lg flex items-center justify-center bg-accent/10">
              <Wallet className="w-5 h-5 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary mb-0.5">Connect with Phantom</p>
              <p className="text-sm text-text-muted">Use your Solana wallet, no password needed</p>
            </div>
            <ArrowRight className="w-5 h-5 text-text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all" />
          </div>
        </Link>
      </div>

      <p className="text-sm text-text-muted text-center mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}
