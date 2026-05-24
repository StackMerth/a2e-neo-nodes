'use client'

/**
 * Solana wallet adapter — provides the ConnectionProvider + WalletProvider
 * + WalletModalProvider stack used by every wallet-sign-to-pay flow on
 * the portal (topup, rental USDC payment, node-runner deploy payment,
 * and link-wallet for email users).
 *
 * Only Phantom, Solflare, and Backpack are registered — the three
 * wallets that cover ~95% of Solana users. Bundling the full
 * wallet-adapter-wallets export pulls in ~1MB of optional adapters
 * (Particle, Trust, Glow, etc.) most of which are dead weight here.
 *
 * RPC endpoint preference order:
 *   1. NEXT_PUBLIC_SOLANA_RPC_URL env var (typically the Helius URL
 *      your API already uses, set explicitly on the Vercel project)
 *   2. NEXT_PUBLIC_SOLANA_NETWORK env var ('mainnet' or 'devnet') →
 *      public default RPC for that network
 *   3. Devnet by default — matches the API's PAYMENT_MODE=dev default.
 */

import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { clusterApiUrl } from '@solana/web3.js'

require('@solana/wallet-adapter-react-ui/styles.css')

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
