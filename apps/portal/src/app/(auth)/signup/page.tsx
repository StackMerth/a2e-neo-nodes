'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowRight, Cpu, Server } from 'lucide-react'
import { Card } from '@/components/ui/Card'

// Must stay in sync with the same key on /register so the two pages
// can share a referral code across the role-picker -> form hop.
const REF_STORAGE_KEY = 'a2e_pending_ref'

export default function SignupPage() {
  const searchParams = useSearchParams()
  const [referralCode, setReferralCode] = useState<string | null>(null)

  // Capture ?ref= once on mount and stash for the /register page to pick up.
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

  // Build the role-specific register URL, forwarding the ref code so
  // the URL stays the source of truth even with localStorage cleared
  // (e.g. private browsing).
  const refSuffix = referralCode ? `&ref=${referralCode}` : ''
  const nodeRunnerHref = `/register${referralCode ? `?ref=${referralCode}` : ''}`
  const buyerHref = `/register?role=buyer${refSuffix}`

  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Create your account</h1>
      <p className="text-text-secondary text-sm mb-6">What are you signing up for?</p>

      {referralCode && (
        <div
          className="text-xs rounded-lg px-3 py-2 mb-4"
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.25)',
            color: 'var(--text-primary)',
          }}
        >
          Invited by <span className="font-mono">{referralCode}</span>. Pick Node Runner to apply the referral; buyers do not earn referrer commission.
        </div>
      )}

      <div className="space-y-3">
        <Link
          href={nodeRunnerHref}
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
                Earn by hosting your GPUs on the A2E network
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-all" />
          </div>
        </Link>

        <Link
          href={buyerHref}
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
