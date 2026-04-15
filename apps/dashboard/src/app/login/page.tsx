'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { LogIn, AlertCircle } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
      {/* Background effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent-purple/5 rounded-full blur-3xl" />
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="w-full max-w-md relative z-10"
      >
        {/* Logo */}
        <motion.div variants={item} className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-5" style={{ background: 'linear-gradient(135deg, var(--accent-green), var(--accent-green-hover, #16a34a))' }}>
            <span className="font-bold text-3xl" style={{ color: 'var(--bg-primary)' }}>A<sup className="text-lg">2</sup>E</span>
          </div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">
            A<sup>2</sup>E Dashboard
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Admin Dashboard</p>
        </motion.div>

        {/* Login Form */}
        <motion.div
          variants={item}
          className="rounded-2xl p-8 backdrop-blur-xl"
          style={{
            background: 'var(--glass-bg)',
            border: '1px solid var(--glass-border)',
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="p-4 rounded-xl flex items-center gap-3" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                <AlertCircle className="w-5 h-5 text-error flex-shrink-0" />
                <p className="text-error text-sm">{error}</p>
              </div>
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
              className="w-full"
              size="lg"
              variant="gradient"
              icon={<LogIn className="w-4 h-4" />}
            >
              Sign In
            </Button>
          </form>
        </motion.div>

        {/* Footer */}
        <motion.div variants={item} className="mt-6 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            A<sup>2</sup>E Arbitrage & Orchestration Engine
          </p>
          <p className="text-xs mt-1">
            <a
              href="https://a2e.byredstone.com/health"
              target="_blank"
              rel="noopener"
              className="hover:text-accent transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              API Status
            </a>
          </p>
        </motion.div>
      </motion.div>
    </div>
  )
}
