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
  // Production (and any non-localhost host): ALWAYS use the server-side
  // /v1/rpc proxy on the API. Never read NEXT_PUBLIC_SOLANA_RPC_URL in
  // production — that env var is inlined into the client bundle at
  // build time, which makes any upstream URL placed there (Helius,
  // Triton, QuickNode) publicly readable in DevTools alongside its
  // query-string API key. Hardcoding the proxy URL here removes the
  // entire leak surface: there is no env var to misconfigure.
  //
  // The proxy itself (apps/api/src/routes/solana-rpc-proxy.ts) reads
  // SOLANA_RPC_URL from the API server's env (server-only, never in
  // any client bundle) and forwards JSON-RPC bodies. From the wallet
  // adapter's perspective the proxy URL is a plain JSON-RPC endpoint,
  // no Helius-specific protocol.
  //
  // localhost dev paths still respect env vars so a developer can
  // point at a local API, a devnet RPC, etc.
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  if (!isLocalhost) {
    const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() || 'https://a2e-api.onrender.com'
    return `${apiBase}/v1/rpc`
  }
  // Local development: NEXT_PUBLIC_SOLANA_RPC_URL is deliberately NOT
  // read here either. Any reference to that env in any code path —
  // even guarded by a runtime check — causes Next.js to inline the
  // build-time value into the bundle, which is exactly the leak we
  // are closing. For local upstream override, point NEXT_PUBLIC_API_URL
  // at a local API instance and configure SOLANA_RPC_URL on that
  // API (server-side, no client exposure).
  const network = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim().toLowerCase()
  if (network === 'devnet') return clusterApiUrl('devnet')
  // Default local: proxy via the configured (or default localhost) API.
  // clusterApiUrl('mainnet-beta') is reserved for the no-API-configured
  // fallback so a fresh checkout still wakes up in mainnet mode.
  const localApi = process.env.NEXT_PUBLIC_API_URL?.trim()
  return localApi ? `${localApi}/v1/rpc` : clusterApiUrl('mainnet-beta')
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
