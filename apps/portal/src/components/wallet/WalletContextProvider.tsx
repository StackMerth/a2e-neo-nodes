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
  // Priority: explicit RPC URL > network override > production default.
  // Switched 2026-06-05: default is now MAINNET-BETA (was devnet).
  // Without any env set, the portal used to talk to devnet, which means
  // signed mainnet USDC txs got broadcast to devnet -> the mainnet USDC
  // mint doesn't exist on devnet -> the SPL token program threw
  // "Attempt to debit an account but found no record of a prior credit",
  // producing a confusing failure for users with real mainnet USDC.
  // Mainnet default matches useUsdcPayment's resolveNetwork() default.
  const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim()
  if (explicit) return explicit
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim().toLowerCase()
  if (network === 'devnet') return clusterApiUrl('devnet')
  // Solana's clusterApiUrl('mainnet-beta') is rate-limited to ~10 req/s
  // and unsuitable for production load. Configure NEXT_PUBLIC_SOLANA_RPC_URL
  // to a Helius / Triton / QuickNode mainnet endpoint for real traffic.
  // This default at least makes a new dev environment functional.
  return clusterApiUrl('mainnet-beta')
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
