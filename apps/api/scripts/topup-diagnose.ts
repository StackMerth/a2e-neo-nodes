/**
 * T2/T3 — quick read-only diagnostic for the buyer topup-destination
 * resolver. Use when the portal shows "Topup destination is not
 * configured. Contact support before paying." Tells you whether
 * SOLANA_TOPUP_WALLET / SOLANA_PAYER_KEY are wired correctly on the
 * current deploy.
 *
 * Run:   pnpm --filter @a2e/api topup:diagnose
 */
import { prisma } from '@a2e/database'
import { getSolanaConfig } from '../src/services/payment/solana.js'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

async function main(): Promise<void> {
  const envWallet = process.env.SOLANA_TOPUP_WALLET?.trim()
  console.log('SOLANA_TOPUP_WALLET set:', Boolean(envWallet))
  if (envWallet) {
    console.log('  value:', envWallet.slice(0, 8) + '...' + envWallet.slice(-4))
  }

  const cfg = await getSolanaConfig(prisma)
  console.log('payer key length:', cfg.payerPrivateKey.length, 'chars')
  console.log('payer key derivable:', cfg.payerPrivateKey.length > 0)
  console.log('devMode:', cfg.devMode)

  if (cfg.payerPrivateKey.length > 0) {
    try {
      const trimmed = cfg.payerPrivateKey.trim()
      let bytes: Uint8Array | null = null
      if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed) && parsed.length === 64) bytes = Uint8Array.from(parsed)
      }
      if (!bytes && /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
        const decoded = bs58.decode(trimmed)
        if (decoded.length === 64) bytes = Uint8Array.from(decoded)
      }
      if (!bytes) {
        const buf = Buffer.from(trimmed, 'base64')
        if (buf.length === 64) bytes = Uint8Array.from(buf)
      }
      if (bytes) {
        const derived = Keypair.fromSecretKey(bytes).publicKey.toBase58()
        console.log('payer key -> derived wallet:', derived.slice(0, 8) + '...' + derived.slice(-4))
        if (envWallet && envWallet !== derived) {
          console.log('  NOTE: derived wallet differs from SOLANA_TOPUP_WALLET (using SOLANA_TOPUP_WALLET as the source of truth).')
        }
      } else {
        console.log('payer key did NOT parse as JSON / base58 / base64. /topup-destination will return configured:false.')
      }
    } catch (err) {
      console.log('payer key parse error:', (err as Error).message)
    }
  }

  console.log()
  console.log('Verdict:')
  if (envWallet || cfg.payerPrivateKey.length > 0) {
    console.log('  OK — /topup-destination should return configured:true. If the portal still says "not configured", the issue is auth (the logged-in user lacks COMPUTE_BUYER / ADMIN role); the endpoint 403s and the page treats that as not-configured.')
  } else {
    console.log('  NOT CONFIGURED — set SOLANA_TOPUP_WALLET in Render API env (3ZTGGh... from T2) and redeploy.')
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
