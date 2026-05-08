'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { LogIn, AlertCircle, Activity } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const } },
}

export default function LoginPage() {
  const { login, isLoading: authLoading } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const result = await login(username, password)

    if (!result.success) {
      setError(result.error || 'Login failed')
    }

    setLoading(false)
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-dark)' }}>
        <div className="flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#22c55e' }} />
          <span className="text-sm">Loading</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden" style={{ background: 'var(--bg-dark)' }}>
      {/* Ambient background — subtle radial glows matching dashboard */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full blur-[120px]"
          style={{ background: 'rgba(34, 197, 94, 0.08)' }}
        />
        <div
          className="absolute bottom-[-20%] right-[-10%] w-[600px] h-[600px] rounded-full blur-[120px]"
          style={{ background: 'rgba(59, 130, 246, 0.06)' }}
        />
        <div
          className="absolute inset-0 opacity-[0.015]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="w-full max-w-[420px] relative z-10"
      >
        {/* Brand */}
        <motion.div variants={item} className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-xl mb-6"
            style={{
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              boxShadow: '0 12px 32px rgba(34, 197, 94, 0.25), 0 0 0 1px rgba(34, 197, 94, 0.15)',
            }}
          >
            <span className="font-bold text-xl tracking-tight" style={{ color: '#0a0a0f' }}>
              A²E
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--text-primary, #fff)' }}>
            A²E Dashboard
          </h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
            Sign in to continue
          </p>
        </motion.div>

        {/* Card */}
        <motion.div
          variants={item}
          className="rounded-2xl p-7 backdrop-blur-xl"
          style={{
            background: 'var(--glass-bg)',
            border: '1px solid var(--glass-border)',
            boxShadow: 'var(--glass-shadow, 0 8px 32px rgba(0,0,0,0.4))',
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-3.5 rounded-xl flex items-center gap-3"
                style={{
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.18)',
                }}
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#ef4444' }} />
                <p className="text-sm" style={{ color: '#fca5a5' }}>
                  {error}
                </p>
              </motion.div>
            )}

            <Input
              label="Username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
              required
            />

            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />

            <Button
              type="submit"
              loading={loading}
              className="w-full mt-2"
              size="lg"
              variant="gradient"
              icon={<LogIn className="w-4 h-4" />}
            >
              Sign In
            </Button>
          </form>
        </motion.div>

        {/* Footer */}
        <motion.div variants={item} className="mt-8 flex flex-col items-center gap-2">
          <p className="text-xs tracking-wide" style={{ color: 'var(--text-muted)' }}>
            A²E Arbitrage & Orchestration Engine
          </p>
          <a
            href={`${process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'}/health`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity"
            style={{ color: 'var(--text-muted)' }}
          >
            <Activity className="w-3 h-3" style={{ color: '#22c55e' }} />
            <span>API Status</span>
          </a>
        </motion.div>
      </motion.div>
    </div>
  )
}
