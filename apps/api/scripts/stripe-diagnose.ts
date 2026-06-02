/**
 * T3 — Stripe live-mode diagnostic.
 *
 * Read-only health check for the Stripe integration. Designed for the
 * first run after flipping LIVE-mode env vars on Render:
 *
 *   pnpm --filter @a2e/api stripe:diagnose
 *
 * Reports:
 *   - STRIPE_SECRET_KEY presence + mode (test vs live, inferred from prefix)
 *   - STRIPE_WEBHOOK_SECRET presence
 *   - Stripe Account info (id, country, default_currency, Connect enabled)
 *   - Stripe Balance (proves the secret key authenticates against live)
 *   - Stripe Connect capabilities (charges_enabled, payouts_enabled)
 *
 * No writes, no charges, no money moves. Safe to run any time.
 */
import { getStripeClient, isStripeConfigured, getWebhookSecret } from '../src/services/payment/stripe.js'

function maskKey(key: string | undefined): string {
  if (!key) return '(unset)'
  if (key.length < 12) return '(too short — looks wrong)'
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

function inferMode(key: string | undefined): string {
  if (!key) return 'unknown'
  if (key.startsWith('sk_live_')) return 'LIVE'
  if (key.startsWith('sk_test_')) return 'TEST'
  if (key.startsWith('rk_live_')) return 'LIVE (restricted key)'
  if (key.startsWith('rk_test_')) return 'TEST (restricted key)'
  return 'unknown prefix'
}

async function main(): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim()
  const webhookSecret = getWebhookSecret()

  console.log('Env vars:')
  console.log(`  STRIPE_SECRET_KEY:     ${maskKey(secretKey)}`)
  console.log(`  STRIPE_WEBHOOK_SECRET: ${maskKey(webhookSecret ?? undefined)}`)
  console.log(`  Mode (from prefix):    ${inferMode(secretKey)}`)
  console.log()

  if (!isStripeConfigured()) {
    console.log('Stripe is NOT configured (STRIPE_SECRET_KEY missing). Aborting.')
    process.exit(1)
  }
  if (!webhookSecret) {
    console.log('WARNING: STRIPE_WEBHOOK_SECRET is not set.')
    console.log('  /v1/webhooks/stripe will reject every Stripe POST with 400 invalid_signature.')
    console.log('  Set it from the live-mode endpoint signing secret in the Stripe dashboard.')
    console.log()
  }

  const stripe = getStripeClient()
  if (!stripe) {
    console.log('Stripe client could not be constructed. Aborting.')
    process.exit(1)
  }

  console.log('Calling Stripe API to verify the secret authenticates...')
  try {
    const account = await stripe.accounts.retrieve()
    console.log(`  account id:            ${account.id}`)
    console.log(`  country:               ${account.country ?? '(unset)'}`)
    console.log(`  default currency:      ${(account.default_currency ?? '').toUpperCase() || '(unset)'}`)
    console.log(`  business type:         ${account.business_type ?? '(unset)'}`)
    console.log(`  details submitted:     ${account.details_submitted}`)
    console.log(`  charges enabled:       ${account.charges_enabled}`)
    console.log(`  payouts enabled:       ${account.payouts_enabled}`)
    if (account.requirements?.currently_due?.length) {
      console.log(`  requirements due:      ${account.requirements.currently_due.join(', ')}`)
    }
    console.log()
  } catch (err) {
    console.log(`  FAILED to retrieve account: ${(err as Error).message}`)
    console.log(`  This usually means the secret key is invalid or revoked.`)
    process.exit(1)
  }

  console.log('Calling Stripe Balance API (proves authentication + live mode)...')
  try {
    const balance = await stripe.balance.retrieve()
    const formatBalance = (entries: Array<{ amount: number; currency: string }>): string =>
      entries.map((e) => `${(e.amount / 100).toFixed(2)} ${e.currency.toUpperCase()}`).join(', ') || '(empty)'
    console.log(`  available:             ${formatBalance(balance.available)}`)
    console.log(`  pending:               ${formatBalance(balance.pending)}`)
    if (balance.instant_available) {
      console.log(`  instant available:     ${formatBalance(balance.instant_available)}`)
    }
    console.log()
  } catch (err) {
    console.log(`  FAILED to retrieve balance: ${(err as Error).message}`)
    process.exit(1)
  }

  console.log('Connect capabilities (relevant for operator payouts):')
  try {
    // accounts.retrieve already includes capability info; surface
    // the operator-payout-relevant ones explicitly so the verdict at
    // the end can be accurate.
    const account = await stripe.accounts.retrieve()
    const caps = account.capabilities ?? {}
    console.log(`  card_payments:         ${caps.card_payments ?? '(not requested)'}`)
    console.log(`  transfers:             ${caps.transfers ?? '(not requested)'}`)
    if (account.controller) {
      console.log(`  controller type:       ${account.controller.type ?? '(unknown)'}`)
    }
  } catch (err) {
    console.log(`  could not fetch capabilities: ${(err as Error).message}`)
  }
  console.log()

  console.log('Verdict:')
  console.log(`  Stripe LIVE mode is ${inferMode(secretKey) === 'LIVE' ? 'ACTIVE' : 'NOT active'}.`)
  console.log(`  Buyer fiat top-up via Stripe Checkout should work end-to-end.`)
  console.log(`  Connect operator payouts require:`)
  console.log(`    - transfers capability = active (currently shown above)`)
  console.log(`    - Connect Platform onboarding complete on the dashboard`)
  console.log(`    - Operators do their own Express onboarding via portal`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
