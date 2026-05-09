'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/components/ui/Toast'
import { auth as authApi } from '@/lib/api'
import { Card } from '@/components/ui/Card'

export default function ConnectWalletPage() {
  const { walletLogin } = useAuth()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isBuyer = searchParams.get('role') === 'buyer'
  const role: 'NODE_RUNNER' | 'COMPUTE_BUYER' = isBuyer ? 'COMPUTE_BUYER' : 'NODE_RUNNER'

  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'select' | 'signing'>('select')

  const connectPhantom = async () => {
    setLoading(true)
    try {
      // Check if Phantom is installed
      const phantom = (window as unknown as { solana?: { isPhantom: boolean; connect: () => Promise<{ publicKey: { toString: () => string } }>; signMessage: (msg: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }> } }).solana
      if (!phantom?.isPhantom) {
        toast('error', 'Phantom wallet not found. Please install it from phantom.app')
        setLoading(false)
        return
      }

      // Connect wallet
      const resp = await phantom.connect()
      const address = resp.publicKey.toString()

      // Get nonce from server
      setStep('signing')
      const { nonce, message } = await authApi.walletNonce(address)

      // Sign the nonce
      const encodedMessage = new TextEncoder().encode(message)
      const { signature } = await phantom.signMessage(encodedMessage, 'utf8')
      const signatureBase64 = Buffer.from(signature).toString('base64')

      // Authenticate. Role is a hint for new wallets only; returning
      // wallets keep their stored role and the redirect uses what the
      // API actually returns.
      const user = await walletLogin(address, signatureBase64, nonce, role)
      toast('success', 'Wallet connected successfully')
      router.push(user.role === 'COMPUTE_BUYER' ? '/buyer/dashboard' : '/dashboard')
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Wallet connection failed')
      setStep('select')
    } finally {
      setLoading(false)
    }
  }

  const heading = isBuyer ? 'Connect Wallet to Buy Compute' : 'Connect Wallet'
  const subline = isBuyer
    ? 'Connect your Solana wallet to rent GPU compute and pay in USDC'
    : 'Connect your Solana wallet to access the node runner portal'
  const otherRoleHref = isBuyer ? '/connect-wallet' : '/connect-wallet?role=buyer'
  const otherRoleLabel = isBuyer ? 'Sign in as Node Runner instead' : 'Sign in as Compute Buyer instead'

  return (
    <Card className="p-8">
      <Link
        href="/login"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to sign in
      </Link>
      <h1 className="text-2xl font-bold text-text-primary mb-2">{heading}</h1>
      <p className="text-text-secondary text-sm mb-2">
        {step === 'select' ? subline : 'Please sign the message in your wallet to verify ownership'}
      </p>
      {step === 'select' && (
        <p className="text-text-muted text-xs mb-6">
          Returning users are sent to the dashboard for the role on file. The choice above only
          applies to first-time wallet sign-ups.
        </p>
      )}

      {step === 'signing' ? (
        <div className="flex flex-col items-center py-8">
          <div className="animate-spin w-10 h-10 border-2 border-accent border-t-transparent rounded-full mb-4" />
          <p className="text-text-secondary text-sm mb-4">Waiting for signature...</p>
          <button
            type="button"
            onClick={() => setStep('select')}
            className="text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={connectPhantom}
            disabled={loading}
            className="w-full flex items-center gap-3 p-4 bg-surface-hover border border-border rounded-xl hover:border-accent/30 transition-all duration-200 disabled:opacity-50"
          >
            <div className="w-10 h-10 rounded-lg bg-[#AB9FF2] flex items-center justify-center">
              <span className="text-white font-bold text-lg">P</span>
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-text-primary">Phantom</p>
              <p className="text-xs text-text-muted">Connect with Phantom wallet</p>
            </div>
          </button>

          <button
            disabled
            className="w-full flex items-center gap-3 p-4 bg-surface border border-border rounded-xl opacity-50 cursor-not-allowed"
          >
            <div className="w-10 h-10 rounded-lg bg-[#FC822B] flex items-center justify-center">
              <span className="text-white font-bold text-lg">S</span>
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-text-primary">Solflare</p>
              <p className="text-xs text-text-muted">Coming soon</p>
            </div>
          </button>
        </div>
      )}

      <div className="mt-6 pt-6 border-t border-border space-y-2 text-center text-sm">
        <Link href={otherRoleHref} className="text-accent hover:underline">
          {otherRoleLabel}
        </Link>
        <p className="text-text-muted">
          Prefer email?{' '}
          <Link href="/login" className="text-accent hover:underline">
            Sign in with email
          </Link>
        </p>
      </div>
    </Card>
  )
}
