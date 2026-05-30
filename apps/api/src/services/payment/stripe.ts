/**
 * Stripe Checkout integration for fiat (card) topups to the buyer
 * credit balance. Uses Stripe Hosted Checkout — buyer is redirected
 * to a Stripe-hosted page to enter card details, returns to the
 * portal on success or cancel, and our webhook handler credits the
 * balance after Stripe confirms the payment server-side.
 *
 * Env vars (set on the Render API service):
 *   STRIPE_SECRET_KEY      — sk_test_... in test mode, sk_live_... in production
 *   STRIPE_WEBHOOK_SECRET  — whsec_... from `stripe listen` or the dashboard
 *
 * Both must be set for fiat topup to be available; the endpoints
 * gracefully 503 when they are missing so the UI can fall back to
 * the Solana topup paths.
 */

// Stripe v22 ships a CJS-style export where the default import is the
// constructor; the namespace types (Event, Checkout.Session, etc.) are
// merged but only reachable as untyped values at our tsconfig settings.
// We avoid the namespace-type juggling by using the SDK's *instance*
// types (StripeClient) for the client and `unknown` for webhook
// payloads, narrowing where needed at the call site.
import StripeLib from 'stripe'

type StripeClient = InstanceType<typeof StripeLib>

let cachedClient: StripeClient | null = null

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim()
}

export function getStripeClient(): StripeClient | null {
  if (cachedClient) return cachedClient
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) return null
  cachedClient = new StripeLib(key, {
    // Pin the API version so a Stripe-side dashboard change does not
    // surprise the integration with a new payload shape. Bump
    // intentionally when we upgrade. Cast through any to avoid the
    // LatestApiVersion type alias dance (not directly reachable from
    // the CJS default export shape in this tsconfig setup).
    apiVersion: '2024-12-18.acacia' as unknown as never,
    typescript: true,
    appInfo: {
      name: 'TokenOS_DeAI',
      version: '1.0.0',
    },
  } as Record<string, unknown>)
  return cachedClient
}

export function getWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null
}

export interface CreateCheckoutArgs {
  userId: string
  email: string | null
  amountUsd: number
  successUrl: string
  cancelUrl: string
}

/**
 * Create a Stripe Checkout Session for a fiat topup. Returns the
 * Session ID + URL the frontend redirects to. The session carries
 * userId in its metadata so the webhook can credit the right
 * balance later, and uses the Session ID itself as the
 * client_reference_id for traceability.
 */
export async function createTopupCheckoutSession(args: CreateCheckoutArgs): Promise<{ id: string; url: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  // Stripe amounts are in the smallest currency unit (cents for USD).
  const amountCents = Math.round(args.amountUsd * 100)
  if (amountCents < 100) {
    throw new Error('Minimum topup is $1.00')
  }
  if (amountCents > 1_000_000) {
    throw new Error('Maximum single topup via card is $10,000.00')
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: 'TokenOS_DeAI compute credit',
            description: `Pre-loaded balance for renting GPU compute on TokenOS_DeAI.`,
          },
        },
      },
    ],
    // metadata travels with the Session into the webhook event, where
    // we read it to know which user to credit.
    metadata: {
      userId: args.userId,
      amountUsd: args.amountUsd.toString(),
      kind: 'buyer_balance_topup',
    },
    payment_intent_data: {
      // Also stamp the PI for downstream audit / refund flows.
      metadata: {
        userId: args.userId,
        amountUsd: args.amountUsd.toString(),
        kind: 'buyer_balance_topup',
      },
    },
    customer_email: args.email ?? undefined,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL')
  }

  return { id: session.id, url: session.url }
}

export interface CreateOperatorDeployCheckoutArgs {
  userId: string
  nodeRunnerId: string
  email: string | null
  amountUsd: number
  gpuTier: string
  nodeCount: number
  // Up to 500 chars (Stripe per-value limit). Surfaced on the
  // Investment row the webhook creates, not visible to Stripe's UI.
  deploymentNote?: string | null
  successUrl: string
  cancelUrl: string
}

/**
 * Create a Stripe Checkout Session for an operator-side node
 * deployment payment. Same Hosted Checkout flow as the buyer topup,
 * but the metadata flags it as kind=operator_deploy so the webhook
 * branches to the Investment-creation path instead of crediting a
 * BuyerBalance. nodeRunnerId / gpuTier / nodeCount travel along so
 * the webhook can reproduce the same Investment row the
 * /v1/portal/node-runner/deploy endpoint would have created.
 */
export async function createOperatorDeployCheckoutSession(
  args: CreateOperatorDeployCheckoutArgs,
): Promise<{ id: string; url: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  const amountCents = Math.round(args.amountUsd * 100)
  if (amountCents < 100) {
    throw new Error('Minimum deploy charge is $1.00')
  }
  if (amountCents > 1_000_000) {
    throw new Error('Maximum single card payment is $10,000.00')
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: `TokenOS_DeAI node deployment (${args.gpuTier} × ${args.nodeCount})`,
            description: `Operator deployment of ${args.nodeCount} ${args.gpuTier} node(s) on TokenOS_DeAI.`,
          },
        },
      },
    ],
    metadata: {
      userId: args.userId,
      nodeRunnerId: args.nodeRunnerId,
      amountUsd: args.amountUsd.toString(),
      gpuTier: args.gpuTier,
      nodeCount: args.nodeCount.toString(),
      kind: 'operator_deploy',
      ...(args.deploymentNote ? { deploymentNote: args.deploymentNote.slice(0, 500) } : {}),
    },
    payment_intent_data: {
      metadata: {
        userId: args.userId,
        nodeRunnerId: args.nodeRunnerId,
        amountUsd: args.amountUsd.toString(),
        gpuTier: args.gpuTier,
        nodeCount: args.nodeCount.toString(),
        kind: 'operator_deploy',
      },
    },
    customer_email: args.email ?? undefined,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL')
  }

  return { id: session.id, url: session.url }
}

export interface CreateDirectRentalCheckoutArgs {
  userId: string
  email: string | null
  amountUsd: number
  // The full rental payload we'll reproduce on the webhook side
  // to create the ComputeRequest. Kept as strings (Stripe metadata
  // values must be strings) and re-parsed on the way out.
  gpuTier: string
  gpuCount: number
  durationDays: number
  ratePerDay: number
  // Optional shaping. Mirrors the regular rental endpoint's payload.
  workloadType?: 'INFERENCE' | 'TRAINING' | 'MIXED'
  tier?: 'ON_DEMAND' | 'SPOT' | 'RESERVED'
  commitmentDays?: number | null
  requiredRegion?: string | null
  preferredOperatorId?: string | null
  purpose?: string | null
  successUrl: string
  cancelUrl: string
}

/**
 * T3.1: create a Stripe Checkout Session for a buyer who wants to
 * pay for a single rental directly with a card (no balance top-up
 * step). The webhook handler on checkout.session.completed reads
 * metadata.kind === 'rental_direct' and creates the ComputeRequest
 * with paymentSource=STRIPE_DIRECT + txHash=session.id, at which
 * point the allocator picks it up on the next 10s tick.
 *
 * Mirror of createTopupCheckoutSession / createOperatorDeployCheckoutSession;
 * the only differences are the metadata.kind and the rental fields
 * we carry through.
 */
export async function createDirectRentalCheckoutSession(
  args: CreateDirectRentalCheckoutArgs,
): Promise<{ id: string; url: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  const amountCents = Math.round(args.amountUsd * 100)
  if (amountCents < 100) {
    throw new Error('Minimum direct rental charge is $1.00')
  }
  if (amountCents > 1_000_000) {
    throw new Error('Maximum single card payment is $10,000.00')
  }

  // Stripe metadata caps each value at 500 chars, max 50 keys. Keep
  // values short + skip falsy ones. The webhook re-parses these on
  // its side; the schema's downstream coercions handle stringy values.
  const metadata: Record<string, string> = {
    userId: args.userId,
    kind: 'rental_direct',
    amountUsd: args.amountUsd.toString(),
    gpuTier: args.gpuTier,
    gpuCount: args.gpuCount.toString(),
    durationDays: args.durationDays.toString(),
    ratePerDay: args.ratePerDay.toString(),
  }
  if (args.workloadType) metadata.workloadType = args.workloadType
  if (args.tier) metadata.tier = args.tier
  if (args.commitmentDays != null) metadata.commitmentDays = args.commitmentDays.toString()
  if (args.requiredRegion) metadata.requiredRegion = args.requiredRegion.slice(0, 80)
  if (args.preferredOperatorId) metadata.preferredOperatorId = args.preferredOperatorId
  if (args.purpose) metadata.purpose = args.purpose.slice(0, 500)

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: `TokenOS_DeAI ${args.gpuCount}× ${args.gpuTier} rental (${args.durationDays}d)`,
            description: `Direct-pay GPU rental on TokenOS_DeAI.`,
          },
        },
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    customer_email: args.email ?? undefined,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL')
  }
  return { id: session.id, url: session.url }
}

// ============================================================================
// T3.2 — Stripe Connect (operator USD payouts)
// ============================================================================
// Operators who want to receive earnings in USD (bank deposit) instead
// of USDC (Solana wallet) onboard via Stripe Connect Express. The
// platform creates a connected account, hands the operator a Stripe-
// hosted onboarding link, and once Stripe activates capabilities the
// platform can call stripe.transfers.create() to push USD from our
// Stripe balance into the operator's connected account. Stripe pays
// out the connected account to the operator's bank on its normal
// payout schedule (daily by default).
//
// Express vs Standard vs Custom: Express is the right pick — Stripe
// hosts the entire onboarding UI (no custom KYC flows for us to
// build), the operator owns the account but our platform processes
// transfers + handles support escalations. Standard would force the
// operator to manage their own Stripe dashboard end-to-end (more
// work for them); Custom would force us to handle KYC ourselves.

export interface CreateConnectAccountArgs {
  email: string | null
  // Country must match Stripe-supported list. Default 'US' is the most
  // common; international operators can pass their ISO code at the
  // route layer.
  country?: string
}

export async function createConnectAccount(args: CreateConnectAccountArgs): Promise<{ id: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  const account = await stripe.accounts.create({
    type: 'express',
    country: args.country ?? 'US',
    email: args.email ?? undefined,
    capabilities: {
      // transfers = we can push money TO this account. card_payments is
      // not requested because the operator is on the receiving side; we
      // are not letting them charge cards through this account.
      transfers: { requested: true },
    },
    business_type: 'individual',
    metadata: {
      kind: 'operator_payout',
    },
  })
  return { id: account.id }
}

/**
 * Generate a one-time onboarding URL Stripe hosts for the operator
 * to complete identity verification, bank info, etc. Link expires
 * after ~5 minutes; the operator returns to returnUrl when done
 * (or to refreshUrl if the link is reused / expired).
 */
export async function createConnectOnboardingLink(args: {
  accountId: string
  returnUrl: string
  refreshUrl: string
}): Promise<{ url: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  const link = await stripe.accountLinks.create({
    account: args.accountId,
    refresh_url: args.refreshUrl,
    return_url: args.returnUrl,
    type: 'account_onboarding',
  })
  return { url: link.url }
}

/**
 * Read the live Stripe-side status of a connected account. We use
 * the `details_submitted` flag + the transfers capability to decide
 * whether the operator is ready to receive payouts.
 */
export async function getConnectAccountStatus(accountId: string): Promise<{
  detailsSubmitted: boolean
  transfersActive: boolean
  payoutsEnabled: boolean
  requirementsCurrentlyDue: string[]
}> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  const account = await stripe.accounts.retrieve(accountId)
  return {
    detailsSubmitted: Boolean(account.details_submitted),
    transfersActive: account.capabilities?.transfers === 'active',
    payoutsEnabled: Boolean(account.payouts_enabled),
    requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
  }
}

/**
 * Push USD from the platform's Stripe balance into the operator's
 * connected account. Returns the Transfer id (`tr_xxxxxx`) which we
 * persist on WithdrawalRequest.stripeTransferId for audit + the
 * operator's records. Stripe then pays out the connected account to
 * the operator's bank on the account's normal cadence.
 *
 * idempotencyKey is the WithdrawalRequest id; Stripe enforces
 * single-shot processing for that key so a route retry can't
 * double-transfer.
 */
export async function createConnectTransfer(args: {
  destinationAccountId: string
  amountUsd: number
  idempotencyKey: string
  description?: string
}): Promise<{ id: string }> {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')

  const amountCents = Math.round(args.amountUsd * 100)
  if (amountCents <= 0) {
    throw new Error('Transfer amount must be > $0.00')
  }

  const transfer = await stripe.transfers.create(
    {
      amount: amountCents,
      currency: 'usd',
      destination: args.destinationAccountId,
      description: args.description ?? `TokenOS_DeAI operator payout`,
    },
    { idempotencyKey: args.idempotencyKey },
  )
  return { id: transfer.id }
}

/**
 * Verify a webhook payload against the configured signing secret.
 * Returns the parsed event; throws on signature mismatch so the
 * route can 400 the request.
 */
// Stripe event shape — narrowed manually because the namespace type
// is not directly importable from the CJS entrypoint (see header comment).
export interface StripeWebhookEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

export function constructWebhookEvent(rawBody: Buffer, signatureHeader: string): StripeWebhookEvent {
  const stripe = getStripeClient()
  if (!stripe) throw new Error('Stripe not configured')
  const secret = getWebhookSecret()
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set')
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret) as unknown as StripeWebhookEvent
}
