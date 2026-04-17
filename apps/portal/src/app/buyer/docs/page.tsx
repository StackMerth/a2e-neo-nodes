'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { BookOpen, Copy, Check, Key, Server, CreditCard, Terminal } from 'lucide-react'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.04 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const API_BASE = 'https://a2e.byredstone.com'

interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  description: string
  auth: 'Bearer JWT' | 'API Key' | 'Both'
  requestBody?: string
  responseExample?: string
}

const SECTIONS: { title: string; icon: React.ReactNode; endpoints: Endpoint[] }[] = [
  {
    title: 'Authentication',
    icon: <Key size={18} />,
    endpoints: [
      {
        method: 'POST', path: '/v1/portal/auth/register',
        description: 'Register a new buyer account',
        auth: 'Both',
        requestBody: '{\n  "email": "buyer@example.com",\n  "password": "securepass123",\n  "role": "COMPUTE_BUYER"\n}',
        responseExample: '{\n  "user": { "id": "...", "email": "...", "role": "COMPUTE_BUYER" },\n  "accessToken": "eyJ...",\n  "refreshToken": "..."\n}',
      },
      {
        method: 'POST', path: '/v1/portal/auth/login',
        description: 'Login and get JWT tokens',
        auth: 'Both',
        requestBody: '{\n  "email": "buyer@example.com",\n  "password": "securepass123"\n}',
        responseExample: '{\n  "user": { "id": "...", "role": "COMPUTE_BUYER" },\n  "accessToken": "eyJ...",\n  "refreshToken": "..."\n}',
      },
      {
        method: 'POST', path: '/v1/portal/auth/refresh',
        description: 'Refresh an expired access token',
        auth: 'Both',
        requestBody: '{ "refreshToken": "..." }',
      },
    ],
  },
  {
    title: 'Compute Requests',
    icon: <Server size={18} />,
    endpoints: [
      {
        method: 'GET', path: '/v1/buyer/dashboard',
        description: 'Get buyer dashboard summary (active compute, spending, requests)',
        auth: 'Both',
        responseExample: '{\n  "activeCompute": 1,\n  "pendingRequests": 0,\n  "totalSpent": 4204.50,\n  "totalRequests": 3,\n  "daysRemaining": 28\n}',
      },
      {
        method: 'POST', path: '/v1/buyer/compute/request',
        description: 'Submit a new compute request',
        auth: 'Both',
        requestBody: '{\n  "gpuTier": "H100",\n  "gpuCount": 1,\n  "durationDays": 30,\n  "purpose": "ML training",\n  "txHash": "5K7x...solana_tx_hash"\n}',
        responseExample: '{\n  "id": "...",\n  "gpuTier": "H100",\n  "gpuCount": 1,\n  "totalCost": 4204.50,\n  "status": "PENDING"\n}',
      },
      {
        method: 'GET', path: '/v1/buyer/compute/requests',
        description: 'List all compute requests (supports ?status= filter)',
        auth: 'Both',
      },
      {
        method: 'GET', path: '/v1/buyer/compute/requests/:id',
        description: 'Get compute request detail (includes SSH when ACTIVE)',
        auth: 'Both',
        responseExample: '{\n  "request": {\n    "id": "...",\n    "status": "ACTIVE",\n    "sshHost": "10.10.10.199",\n    "sshPort": 22,\n    "sshUsername": "root",\n    "sshPassword": "...",\n    "expiresAt": "2026-05-17T00:00:00Z"\n  }\n}',
      },
      {
        method: 'GET', path: '/v1/buyer/compute/active',
        description: 'List only active compute allocations with SSH details',
        auth: 'Both',
      },
      {
        method: 'PATCH', path: '/v1/buyer/compute/requests/:id/cancel',
        description: 'Cancel a pending compute request',
        auth: 'Both',
      },
    ],
  },
  {
    title: 'Billing',
    icon: <CreditCard size={18} />,
    endpoints: [
      {
        method: 'GET', path: '/v1/buyer/billing',
        description: 'Billing overview with monthly breakdown',
        auth: 'Both',
      },
      {
        method: 'GET', path: '/v1/buyer/billing/invoice/:requestId',
        description: 'Generate HTML invoice for a compute request',
        auth: 'Both',
      },
    ],
  },
  {
    title: 'API Keys',
    icon: <Key size={18} />,
    endpoints: [
      {
        method: 'POST', path: '/v1/buyer/api-keys',
        description: 'Create a new API key',
        auth: 'Bearer JWT',
        requestBody: '{\n  "name": "Production",\n  "expiresInDays": 90\n}',
        responseExample: '{\n  "id": "...",\n  "key": "a2e-buyer-...",\n  "name": "Production",\n  "message": "Save this key now"\n}',
      },
      {
        method: 'GET', path: '/v1/buyer/api-keys',
        description: 'List API keys (masked)',
        auth: 'Bearer JWT',
      },
      {
        method: 'DELETE', path: '/v1/buyer/api-keys/:id',
        description: 'Revoke an API key',
        auth: 'Bearer JWT',
      },
    ],
  },
]

const METHOD_COLORS: Record<string, { bg: string; color: string }> = {
  GET: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e' },
  POST: { bg: 'rgba(59,130,246,0.15)', color: '#3b82f6' },
  PATCH: { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
  DELETE: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444' },
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="p-1 rounded transition-colors hover:opacity-80"
      style={{ color: 'var(--text-muted)' }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

export default function ApiDocsPage() {
  return (
    <motion.div className="space-y-8 max-w-4xl" variants={container} initial="hidden" animate="show">
      <motion.div variants={item}>
        <h1 className="text-2xl font-bold flex items-center gap-3" style={{ color: 'var(--text-primary)' }}>
          <BookOpen size={28} style={{ color: 'var(--primary)' }} />
          API Documentation
        </h1>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          Use these endpoints to programmatically manage your compute resources.
        </p>
      </motion.div>

      {/* Auth Guide */}
      <motion.div variants={item}>
        <div className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Terminal size={16} style={{ color: 'var(--primary)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Authentication</h2>
          </div>
          <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
            Two authentication methods are supported:
          </p>
          <div className="space-y-3 text-sm">
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-card)' }}>
              <p className="font-medium" style={{ color: 'var(--text-primary)' }}>1. Bearer Token (JWT)</p>
              <code className="text-xs mt-1 block" style={{ color: 'var(--primary)' }}>Authorization: Bearer eyJ...</code>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Get a token via /v1/portal/auth/login. Expires in 15 minutes. Use refresh token to renew.</p>
            </div>
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-card)' }}>
              <p className="font-medium" style={{ color: 'var(--text-primary)' }}>2. API Key</p>
              <code className="text-xs mt-1 block" style={{ color: 'var(--primary)' }}>X-API-Key: a2e-buyer-...</code>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Create via the API Keys page. No expiry unless set. Good for server-to-server use.</p>
            </div>
          </div>
          <div className="mt-3 p-3 rounded-lg" style={{ background: 'var(--bg-card)' }}>
            <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Base URL</p>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-xs" style={{ color: 'var(--primary)' }}>{API_BASE}</code>
              <CopyBtn text={API_BASE} />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Endpoint Sections */}
      {SECTIONS.map((section) => (
        <motion.div key={section.title} variants={item}>
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
            <div className="px-6 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
              <span style={{ color: 'var(--primary)' }}>{section.icon}</span>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{section.title}</h2>
            </div>
            <div className="divide-y" style={{ borderColor: 'var(--glass-border)' }}>
              {section.endpoints.map((ep) => {
                const mc = METHOD_COLORS[ep.method]!
                return (
                  <div key={ep.path} className="px-6 py-4">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ background: mc.bg, color: mc.color }}>{ep.method}</span>
                      <code className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{ep.path}</code>
                      <CopyBtn text={`${API_BASE}${ep.path}`} />
                    </div>
                    <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>{ep.description}</p>
                    <span className="text-2xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--primary)' }}>Auth: {ep.auth}</span>
                    {ep.requestBody && (
                      <div className="mt-3">
                        <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Request Body</p>
                        <pre className="text-xs p-3 rounded-lg overflow-x-auto" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>{ep.requestBody}</pre>
                      </div>
                    )}
                    {ep.responseExample && (
                      <div className="mt-3">
                        <p className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Response Example</p>
                        <pre className="text-xs p-3 rounded-lg overflow-x-auto" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>{ep.responseExample}</pre>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </motion.div>
      ))}

      {/* GPU Pricing */}
      <motion.div variants={item}>
        <div className="rounded-xl p-6" style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>GPU Pricing</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--glass-border)', color: 'var(--text-muted)' }}>
                  <th className="text-left py-2 text-xs uppercase">Tier</th>
                  <th className="text-right py-2 text-xs uppercase">Hourly</th>
                  <th className="text-right py-2 text-xs uppercase">Daily</th>
                  <th className="text-right py-2 text-xs uppercase">30-Day</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { tier: 'H100', hourly: 5.84, daily: 140.15 },
                  { tier: 'H200', hourly: 7.49, daily: 179.85 },
                  { tier: 'B200', hourly: 13.38, daily: 321.10 },
                  { tier: 'B300', hourly: 17.99, daily: 431.75 },
                  { tier: 'GB300', hourly: 20.81, daily: 499.35 },
                ].map(g => (
                  <tr key={g.tier} style={{ borderBottom: '1px solid var(--glass-border)' }}>
                    <td className="py-2 font-medium" style={{ color: 'var(--primary)' }}>{g.tier}</td>
                    <td className="py-2 text-right" style={{ color: 'var(--text-secondary)' }}>${g.hourly}/hr</td>
                    <td className="py-2 text-right" style={{ color: 'var(--text-secondary)' }}>${g.daily}/day</td>
                    <td className="py-2 text-right font-medium" style={{ color: 'var(--text-primary)' }}>${(g.daily * 30).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
