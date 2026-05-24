'use client'

/**
 * Solana wallet adapter — provides the ConnectionProvider + WalletProvider
 * + WalletModalProvider stack used by every wallet-sign-to-pay flow on
 * the portal (topup, rental USDC payment, node-runner deploy payment,
 * and link-wallet for email users).
 *
 * Imports Phantom + Solflare from their standalone packages, NOT from
 * the umbrella @solana/wallet-adapter-wallets. The umbrella pulls in
 * every adapter (Torus, Particle, Trust, Glow, etc.); Torus in
 * particular drags in ethereum-cryptography which conflicts with a
 * newer @noble/hashes shape and breaks the production webpack build.
 * Standalone packages have no such fanout.
 *
 * RPC endpoint preference order:
 *   1. NEXT_PUBLIC_SOLANA_RPC_URL env var (typically the Helius URL
 *      your API already uses, set explicitly on the Vercel project)
 *   2. NEXT_PUBLIC_SOLANA_NETWORK env var ('mainnet' or 'devnet') →
 *      public default RPC for that network
 *   3. Devnet by default — matches the API's PAYMENT_MODE=dev default.
 *
 * Note on the wallet-adapter CSS: imported at the layout level
 * (apps/portal/src/app/layout.tsx), NOT inside this client component.
 * Side-effect CSS imports inside `'use client'` modules do not bundle
 * cleanly in Next.js App Router production builds.
 */

import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { clusterApiUrl } from '@solana/web3.js'

function resolveEndpoint(): string {
  const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim()
  if (explicit) return explicit
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim()
  if (network === 'mainnet' || network === 'mainnet-beta') {
    return clusterApiUrl('mainnet-beta')
  }
  return clusterApiUrl('devnet')
}

export function WalletContextProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => resolveEndpoint(), [])
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  )

  return (
    <ConnectionProvider endpoint={endpoint}>
      {/* autoConnect=true so a returning user with an authorized
          wallet adapter reconnects silently on every page load —
          they don't have to click Connect again. */}
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
