'use client'

import Link from 'next/link'
import { ArrowRight, Cpu, Server } from 'lucide-react'
import { Card } from '@/components/ui/Card'

export default function SignupPage() {
  return (
    <Card className="p-8">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Create your account</h1>
      <p className="text-text-secondary text-sm mb-6">What are you signing up for?</p>

      <div className="space-y-3">
        <Link
          href="/register"
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
          href="/register?role=buyer"
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
