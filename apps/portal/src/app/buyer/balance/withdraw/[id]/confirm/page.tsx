'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { Check, AlertTriangle, Loader2, ArrowLeft } from 'lucide-react'
import { apiFetch } from '@/lib/api'

type ConfirmState =
  | { kind: 'loading' }
  | { kind: 'success'; message: string; amountUsd?: number }
  | { kind: 'error'; title: string; message: string }
  | { kind: 'missing-token' }

export default function WithdrawConfirmPage() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [state, setState] = useState<ConfirmState>({ kind: 'loading' })

  useEffect(() => {
    const id = params?.id
    const token = searchParams?.get('token')
    if (!id) {
      setState({ kind: 'error', title: 'Bad link', message: 'Missing withdrawal id in URL.' })
      return
    }
    if (!token) {
      setState({ kind: 'missing-token' })
      return
    }

    void (async () => {
      try {
        const resp = await apiFetch<{
          id: string
          status: string
          confirmedAt?: string
          message?: string
        }>(`/v1/buyer/balance/withdraw/${id}/confirm`, {
          method: 'POST',
          body: { token },
        })
        setState({
          kind: 'success',
          message: resp.message ?? 'Confirmation received. Withdrawal is in admin review.',
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Confirmation failed'
        // apiFetch surfaces server error messages; map common ones to a
        // friendlier title.
        let title = 'Confirmation failed'
        if (msg.toLowerCase().includes('expired')) title = 'Link expired'
        else if (msg.toLowerCase().includes('already')) title = 'Already confirmed'
        else if (msg.toLowerCase().includes('invalid_token')) title = 'Invalid link'
        setState({ kind: 'error', title, message: msg })
      }
    })()
  }, [params?.id, searchParams])

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--bg-primary)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-8"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
        }}
      >
        {state.kind === 'loading' && (
          <div className="flex flex-col items-center gap-4 py-6">
            <Loader2 className="w-10 h-10 animate-spin" style={{ color: 'var(--primary)' }} />
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Confirming your withdrawal…
            </p>
          </div>
        )}

        {state.kind === 'success' && (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(34, 197, 94, 0.15)' }}
            >
              <Check size={28} style={{ color: 'var(--primary)' }} />
            </div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Withdrawal confirmed
            </h1>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {state.message}
            </p>
            <button
              onClick={() => router.push('/buyer/balance')}
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg"
              style={{
                background: 'var(--primary)',
                color: 'var(--bg-primary)',
              }}
            >
              <ArrowLeft size={14} /> Back to Balance
            </button>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(239, 68, 68, 0.15)' }}
            >
              <AlertTriangle size={28} style={{ color: 'var(--danger)' }} />
            </div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              {state.title}
            </h1>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {state.message}
            </p>
            <button
              onClick={() => router.push('/buyer/balance')}
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg"
              style={{
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
              }}
            >
              <ArrowLeft size={14} /> Back to Balance
            </button>
          </div>
        )}

        {state.kind === 'missing-token' && (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(245, 158, 11, 0.15)' }}
            >
              <AlertTriangle size={28} style={{ color: 'var(--warn)' }} />
            </div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              Missing confirmation token
            </h1>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              This page expects a <code>?token=…</code> query parameter from your
              confirmation email. Open the link from your inbox again, or request a
              new withdrawal.
            </p>
            <button
              onClick={() => router.push('/buyer/balance')}
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg"
              style={{
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
              }}
            >
              <ArrowLeft size={14} /> Back to Balance
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
