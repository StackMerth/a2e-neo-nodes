import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createNotification } from '../services/notification/service.js'
import { creditCompletedRental } from '../services/revenue/rental-credit.js'
import { terminateExternalRentalForRequest, UnknownProviderError } from '../services/inbound/terminate-dispatcher.js'
import { decryptPrivateKey } from '../services/inbound/key-encryption.js'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import { checkIdempotencyKey, storeIdempotencyResponse } from '../services/idempotency/keys.js'
import { getSolanaConfig, processPayment } from '../services/payment/solana.js'
import { createDirectRentalCheckoutSession, isStripeConfigured } from '../services/payment/stripe.js'
import { getOperatorBalanceBreakdown } from '../services/settlement/engine.js'
import {
  getOrCreateBalance,
  debitBalance,
  creditBalance,
  InsufficientBalanceError,
} from '../services/balance/balance-service.js'
import { getConfidentialComputeUiMode } from './buyer-confidential-interest.js'

const GPU_DAILY_RATES: Record<string, number> = {
  H100: 140.15, H200: 179.85, L40S: 21, B200: 321.10, B300: 431.75, GB300: 499.35,
  // C2 wave 2: consumer / prosumer tier pricing (market-standard,
  // tunable via YieldFloor per-tier in admin /rates). Allocator
  // gates these to workloadType=INFERENCE only — see compute-allocator.ts.
  RTX_4090: 14, RTX_3090: 9, CONSUMER: 7,
}

const requestSchema = z.object({
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
  // gpuCount cap: 64 covers single-rack NVL72 / NVL36 cluster requests
  // with headroom. >64 requires an admin-side enterprise quote — keeps
  // a single self-serve buyer from accidentally requesting half the
  // available H100 inventory in one click. Bump again later if real
  // demand pushes against this ceiling.
  gpuCount: z.number().int().min(1).max(64).default(1),
  // M2: 1-day minimum. The 7-day Phase 1 minimum predates per-minute
  // billing and contradicted its core value (try a few hours, pay for
  // exactly what you used). 1-day floor gives the meter a sane window
  // to operate over while keeping the form simple.
  durationDays: z.number().int().min(1).max(365).default(7),
  purpose: z.string().max(500).optional(),
  // Payment source. USDC = real Solana transfer (txHash required and
  // is the on-chain signature). INTERNAL_BALANCE = paid from the
  // user's accumulated operator balance (txHash optional, server
  // generates INTERNAL:<computeRequestId>; user must also be a
  // NodeRunner with enough available balance). BUYER_BALANCE = drawn
  // from the buyer's pre-loaded credit balance (txHash optional,
  // server generates BAL:<computeRequestId>; balanceTransactionId is
  // linked back so refunds credit the same balance).
  paymentSource: z.enum(['USDC', 'INTERNAL_BALANCE', 'BUYER_BALANCE']).default('USDC'),
  txHash: z.string().min(1).optional(),
  // M3: pricing tier (default ON_DEMAND keeps existing flows working).
  //   ON_DEMAND — full price, never preempted, no commitment
  //   SPOT      — discounted (default 40% off via SPOT_DISCOUNT_PCT),
  //               preemptible with 90s notice
  //   RESERVED  — 10% off, exempt from preemption, requires
  //               commitmentDays in {7, 30, 90}
  tier: z.enum(['ON_DEMAND', 'SPOT', 'RESERVED']).default('ON_DEMAND'),
  // C2 wave 2: workload-type declaration. Drives the allocator's
  // consumer-tier eligibility filter. INFERENCE matches all tiers
  // (including CONSUMER / RTX_4090 / RTX_3090); TRAINING and MIXED
  // hard-filter consumer tiers out. Default MIXED preserves the
  // pre-wave-2 routing semantics for buyers who don't pick.
  workloadType: z.enum(['INFERENCE', 'TRAINING', 'MIXED']).default('MIXED'),
  // T5e + friend feedback 2026-06-02: when true, allocator skips
  // RunPod COMMUNITY tier and routes only to dedicated supply
  // (internal operators, Lambda, RunPod SECURE). Use for variance-
  // sensitive workloads where co-tenant noise on the physical host
  // distorts results (benchmarks, reproducible inference
  // measurements). Default false — most rentals don't care and
  // benefit from cheaper COMMUNITY tier capacity.
  preferDedicatedTier: z.boolean().default(false),
  // T7: hardware-attested confidential compute toggle. When true the
  // allocator skips Lambda / RunPod / internal nodes (none provide
  // TEE) and routes only to confidential-capable suppliers (Phala,
  // io.net allow-listed, VoltageGPU). Falls through to
  // WAITING_ON_CAPACITY with "no confidential supply" if no provider
  // has stock — DOES NOT silently downgrade to unattested hardware.
  preferConfidential: z.boolean().default(false),
  commitmentDays: z.number().int().refine(d => [7, 30, 90].includes(d), {
    message: 'commitmentDays must be 7, 30, or 90',
  }).optional(),
  // M4.4: optional region constraint. Free-form string matching the
  // values operators put on Node.region (e.g. us-east-1, us-west-2,
  // eu-west-1, ap-south-1). Empty / null means "Any" — allocator
  // skips the region filter entirely.
  requiredRegion: z.string().max(64).optional().nullable(),

  // M5.10c: optional operator preference. Slug from the marketplace
  // (e.g. "seed-gold-runner"). Server resolves to NodeRunner.id and
  // stores it on ComputeRequest.preferredOperatorId. Soft preference:
  // the allocator sorts that operator's nodes first but falls back to
  // the general pool when they have no idle capacity.
  preferredOperatorSlug: z.string().max(120).optional().nullable(),

  // M6 / launch-blocker #2 dependency: buyer's SSH public key. The
  // agent installs this into the rental user's authorized_keys at
  // provision time; without it the rental lands in FAILED. Accepts
  // ssh-rsa / ssh-ed25519 / ecdsa-sha2-nistp* / ssh-dss canonical
  // formats, with an optional trailing comment.
  sshPubKey: z
    .string()
    .max(8192)
    .regex(
      /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+.+)?$/,
      'sshPubKey must be a canonical openssh public key'
    )
    .optional(),

  // Checkpoint Workspace restore: the buyer can optionally point a new
  // rental at a prior checkpoint they own. At provision time the agent
  // downloads the tarball from S3 and unpacks it into the new rental's
  // home dir before SSH is opened, so the buyer lands in their old
  // workspace. Server validates ownership + READY status against the
  // ComputeRequest carrying this lastCheckpointId.
  restoreCheckpointId: z.string().optional().nullable(),
}).refine(
  data => data.tier !== 'RESERVED' || data.commitmentDays !== undefined,
  { message: 'commitmentDays required for RESERVED tier', path: ['commitmentDays'] },
).refine(
  data => data.tier === 'RESERVED' || data.commitmentDays === undefined,
  { message: 'commitmentDays only allowed on RESERVED tier', path: ['commitmentDays'] },
).refine(
  // USDC payments must carry a txHash; INTERNAL_BALANCE and BUYER_BALANCE
  // don't (server generates a synthetic INTERNAL:<id> / BAL:<id> hash
  // post-insert).
  data => data.paymentSource !== 'USDC' || (data.txHash && data.txHash.length > 0),
  { message: 'txHash is required for USDC payments', path: ['txHash'] },
).refine(
  // C2 wave 2: consumer GPU tiers are inference-only. Reject obvious
  // mistakes at the request boundary so the allocator never has to
  // deal with an impossible combination later.
  data => {
    const consumerTiers = ['CONSUMER', 'RTX_4090', 'RTX_3090']
    if (consumerTiers.includes(data.gpuTier) && data.workloadType !== 'INFERENCE') {
      return false
    }
    return true
  },
  { message: 'Consumer GPU tiers only support workloadType=INFERENCE', path: ['workloadType'] },
)

// M3 pricing modifiers. ON_DEMAND = full price baseline. SPOT and
// RESERVED apply discounts. Tunable so the operator can dial without
// a redeploy when market prices shift.
//
// Env values are read as DECIMAL fractions (0.4 = 40%, not 40). The
// stripe-checkout path used to read the same env as a percent (line
// 868-style `/ 100`) which made the two pricing paths diverge whenever
// the env var was set — pick a single convention here and have the
// helper functions below be the only place that consumes them.
function parsePricingFraction(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback
  const parsed = parseFloat(envValue)
  if (!Number.isFinite(parsed)) return fallback
  // Defensive normalisation: if someone sets `40` instead of `0.4`,
  // interpret it as a percent and clamp into [0, 1] so we never
  // produce a negative multiplier downstream.
  const normalised = parsed > 1 ? parsed / 100 : parsed
  return Math.min(Math.max(normalised, 0), 1)
}
const SPOT_DISCOUNT_PCT = parsePricingFraction(process.env.SPOT_DISCOUNT_PCT, 0.4)
const RESERVED_DISCOUNT_PCT = parsePricingFraction(process.env.RESERVED_DISCOUNT_PCT, 0.1)

// Per-tier minimum daily price floor. The buyer-side ratePerDay can
// never go below this, regardless of how the SPOT / INFERENCE / future
// discounts stack. Derived from the supplier-side STATIC_PRICES in
// capacity-probe.ts (cheapest provider's per-hour cost × 24 × 1.25 for
// a 25% minimum platform margin). When supplier prices shift, update
// both this floor AND STATIC_PRICES together so the relationship holds.
//
// Why we need this: L40S full price $21/day = $0.875/h, but cheapest
// supplier (RunPod) costs $0.79/h. A SPOT + INFERENCE stack (0.6 ×
// 0.8 = 0.48) drops the buyer price to $0.42/h — below cost, every
// minute is a guaranteed loss. The floor stops the stack before the
// math goes underwater.
const GPU_PRICE_FLOOR_DAILY: Record<string, number> = {
  H100:     56.10, // supplier $1.87/h × 24 × 1.25
  H200:    100.00, // supplier $3.29/h × 24 × 1.25 = $98.70
  L40S:     23.70, // supplier $0.79/h × 24 × 1.25
  B200:    165.00, // supplier $5.49/h × 24 × 1.25 = $164.70
  B300:    200.00,
  GB300:   240.00,
  RTX_4090: 10.20, // supplier $0.34/h × 24 × 1.25
  RTX_3090:  9.00, // supplier $0.30/h × 24 × 1.25 (RUNPOD STATIC_PRICES)
  CONSUMER:  6.00,
  OTHER:     6.00,
}

function applyPriceFloor(ratePerDay: number, gpuTier: string): number {
  const floor = GPU_PRICE_FLOOR_DAILY[gpuTier]
  if (floor && ratePerDay < floor) return floor
  return ratePerDay
}

// Workload-type discount: INFERENCE workloads on datacenter tiers run
// shorter, hit less VRAM, and use less power than TRAINING / MIXED on
// the same hardware. Offer a buyer-side discount to reflect that.
// Consumer tiers (CONSUMER / RTX_4090 / RTX_3090) are already priced
// for inference and are excluded so we don't double-discount.
const INFERENCE_DISCOUNT_PCT = parseFloat(process.env.INFERENCE_DISCOUNT_PCT ?? '0.2') // 20% off
const CONSUMER_TIER_SET = new Set(['CONSUMER', 'RTX_4090', 'RTX_3090'])

function workloadPricingMultiplier(
  workloadType: 'INFERENCE' | 'TRAINING' | 'MIXED',
  gpuTier: string,
): number {
  if (workloadType !== 'INFERENCE') return 1
  if (CONSUMER_TIER_SET.has(gpuTier)) return 1
  return 1 - INFERENCE_DISCOUNT_PCT
}

function tierPricingMultiplier(tier: 'ON_DEMAND' | 'SPOT' | 'RESERVED'): number {
  if (tier === 'SPOT') return 1 - SPOT_DISCOUNT_PCT
  if (tier === 'RESERVED') return 1 - RESERVED_DISCOUNT_PCT
  return 1
}

const listSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.string().optional(),
})

export async function buyerComputeRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * GET /v1/buyer/compute/internal-balance
   *
   * Tells the buyer UI whether the "Pay from operator balance" option
   * should appear on the request form and what the live available
   * balance is. eligible=false when the user has no NodeRunner profile
   * (pure buyer) — the option stays hidden in that case. Buyers with
   * a dual identity see their available balance so they can decide.
   *
   * The actual debit happens server-side at request submit time via
   * the same getOperatorBalanceBreakdown call — this endpoint exists
   * purely so the UI can pre-validate before bothering the user with
   * a 402.
   */
  fastify.get('/v1/buyer/compute/internal-balance', async (request, reply) => {
    const userId = request.user!.userId
    const nr = await fastify.prisma.nodeRunner.findUnique({
      where: { userId },
      select: { id: true },
    })
    if (!nr) {
      return reply.send({ eligible: false, available: 0, spent: 0 })
    }
    const breakdown = await getOperatorBalanceBreakdown(fastify.prisma, nr.id)
    reply.send({
      eligible: true,
      available: breakdown.available,
      spent: breakdown.spent,
      pending: breakdown.pending,
    })
  })

  /**
   * GET /v1/buyer/dashboard
   */
  fastify.get('/v1/buyer/dashboard', async (request, reply) => {
    const userId = request.user!.userId

    const [active, pending, totalSpent, allRequests] = await Promise.all([
      fastify.prisma.computeRequest.count({ where: { userId, status: 'ACTIVE' } }),
      fastify.prisma.computeRequest.count({ where: { userId, status: { in: ['PENDING', 'APPROVED', 'ALLOCATED'] } } }),
      fastify.prisma.computeRequest.aggregate({ where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } }, _sum: { totalCost: true } }),
      fastify.prisma.computeRequest.count({ where: { userId } }),
    ])

    // Find nearest expiry
    const nearestExpiry = await fastify.prisma.computeRequest.findFirst({
      where: { userId, status: 'ACTIVE', expiresAt: { not: null } },
      orderBy: { expiresAt: 'asc' },
      select: { expiresAt: true },
    })

    const daysRemaining = nearestExpiry?.expiresAt
      ? Math.max(0, Math.ceil((nearestExpiry.expiresAt.getTime() - Date.now()) / 86400000))
      : null

    // Fetch active allocations and recent requests for dashboard display
    const [activeAllocations, recentRequests] = await Promise.all([
      fastify.prisma.computeRequest.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: { activatedAt: 'desc' },
        take: 5,
        select: { id: true, gpuTier: true, gpuCount: true, sshHost: true, sshPort: true, sshUsername: true, sshPassword: true, expiresAt: true, activatedAt: true },
      }),
      fastify.prisma.computeRequest.findMany({
        where: { userId },
        orderBy: { requestedAt: 'desc' },
        take: 5,
        select: { id: true, gpuTier: true, gpuCount: true, durationDays: true, totalCost: true, status: true, requestedAt: true },
      }),
    ])

    reply.send({
      activeCompute: active,
      pendingRequests: pending,
      totalSpent: totalSpent._sum.totalCost ?? 0,
      totalRequests: allRequests,
      daysRemaining,
      activeAllocations,
      recentRequests,
    })
  })

  /**
   * POST /v1/buyer/compute/request — Submit compute request.
   *
   * Idempotency: two layers of protection against accidental double-submit.
   *   1. Standard `Idempotency-Key` header — if a buyer client sets one, we
   *      replay the cached response on retry (same as /v1/payments/process).
   *   2. txHash dedup — even without the header, a Solana payment tx hash
   *      is a one-shot financial event. If the same userId already has a
   *      compute request with this txHash we return that one instead of
   *      creating a duplicate. Defends against double-clicking submit.
   */
  fastify.post('/v1/buyer/compute/request', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.errors.map(e => e.message).join(', ') })
    }

    const { gpuTier, gpuCount, durationDays, purpose, txHash, tier, commitmentDays, requiredRegion, preferredOperatorSlug, sshPubKey, paymentSource, workloadType, preferDedicatedTier, preferConfidential, restoreCheckpointId } = parsed.data

    // Defense-in-depth: when CONFIDENTIAL_COMPUTE_UI_MODE is waitlist
    // or hidden, no confidential supply is reliably online. Reject
    // preferConfidential=true here so a buyer who hand-crafts an API
    // call (or whose portal cache is stale) doesn't end up with a
    // debited balance and a permanently-WAITING ComputeRequest. The
    // portal's primary defense is to render the waitlist UI; this is
    // the server-side guarantee.
    if (preferConfidential) {
      const mode = getConfidentialComputeUiMode()
      if (mode !== 'active') {
        return reply.code(422).send({
          error: 'Confidential Compute Waitlisted',
          message:
            'Confidential compute is temporarily waitlisted while we onboard suppliers. Join the waitlist at /v1/buyer/compute/confidential-interest to be notified when capacity returns. No payment is taken.',
          uiMode: mode,
        })
      }
    }

    // M5.10c: resolve preferred operator slug to NodeRunner.id. Silently
    // ignore unknown slugs (don't fail the request - the allocator just
    // proceeds without the soft preference if the operator can't be
    // matched).
    let preferredOperatorId: string | null = null
    if (preferredOperatorSlug) {
      const match = await fastify.prisma.nodeRunner.findUnique({
        where: { slug: preferredOperatorSlug },
        select: { id: true },
      })
      preferredOperatorId = match?.id ?? null
    }

    // Checkpoint Workspace restore: verify the requested checkpoint
    // belongs to this buyer AND is in READY state before we let the
    // request reference it. Failing loud here (400) instead of silently
    // dropping the value so the buyer notices when their pick is stale.
    if (restoreCheckpointId) {
      const sourceRental = await fastify.prisma.computeRequest.findFirst({
        where: {
          userId: request.user!.userId,
          lastCheckpointId: restoreCheckpointId,
          checkpointStatus: 'READY',
        },
        select: { id: true },
      })
      if (!sourceRental) {
        return reply.code(400).send({
          error: 'invalid_checkpoint',
          message: 'Checkpoint not found, not yours, or not in READY state.',
        })
      }
    }
    const baseRatePerDay = GPU_DAILY_RATES[gpuTier] ?? 140.15
    // M3 tier discount (SPOT / RESERVED) + workload-type discount
    // (INFERENCE on datacenter tiers) compose multiplicatively. Both
    // ride on ratePerDay so totalCost, allocator-set ratePerMinute,
    // and refund math all inherit the final rate automatically.
    // Floor enforced after composition so we never sell below
    // supplier cost — see GPU_PRICE_FLOOR_DAILY for rationale.
    const ratePerDay = applyPriceFloor(
      baseRatePerDay
        * tierPricingMultiplier(tier)
        * workloadPricingMultiplier(workloadType, gpuTier),
      gpuTier,
    )
    // For RESERVED, the rental's effective duration is the commitment
    // period (always >= durationDays). Buyer locks in commitmentDays;
    // we overwrite durationDays so ACTIVE rentals' expiresAt is set
    // correctly by the allocator.
    const effectiveDurationDays = tier === 'RESERVED' && commitmentDays
      ? commitmentDays
      : durationDays
    const totalCost = ratePerDay * gpuCount * effectiveDurationDays
    const userId = request.user!.userId

    // Buyer-balance pre-check: confirm the pre-loaded credit balance
    // covers this rental BEFORE the idempotency layer so an
    // insufficient-balance rejection isn't accidentally cached as a
    // successful response. Real debit happens inside the create
    // transaction below.
    if (paymentSource === 'BUYER_BALANCE') {
      const snapshot = await getOrCreateBalance(fastify.prisma, userId)
      if (snapshot.balanceUsd < totalCost) {
        return reply.code(402).send({
          error: 'Payment Required',
          message: `Insufficient buyer balance: need $${totalCost.toFixed(2)}, have $${snapshot.balanceUsd.toFixed(2)} available.`,
          required: totalCost,
          available: snapshot.balanceUsd,
          topupHint: 'Top up at /buyer/balance.',
        })
      }
    }

    // Internal-spend: resolve the buyer's NodeRunner profile and
    // confirm available balance covers the rental. Done BEFORE the
    // idempotency check so an insufficient-balance rejection never
    // gets cached as a successful outcome. Skip when paying with
    // USDC — the txHash dedup and idempotency layers handle that
    // path.
    let internalSpendNodeRunnerId: string | null = null
    if (paymentSource === 'INTERNAL_BALANCE') {
      const nr = await fastify.prisma.nodeRunner.findUnique({
        where: { userId },
        select: { id: true },
      })
      if (!nr) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Paying from internal balance requires an operator profile. Sign up as a node runner first.',
        })
      }
      const breakdown = await getOperatorBalanceBreakdown(fastify.prisma, nr.id)
      if (breakdown.available < totalCost) {
        return reply.code(402).send({
          error: 'Payment Required',
          message: `Insufficient balance: need $${totalCost.toFixed(2)}, have $${breakdown.available.toFixed(2)} available.`,
          required: totalCost,
          available: breakdown.available,
        })
      }
      internalSpendNodeRunnerId = nr.id
    }

    // txHash is required for USDC (zod refine guarantees it); for
    // INTERNAL_BALANCE the server synthesizes one post-insert from
    // the created computeRequest.id. The isTestTx check only makes
    // sense for USDC.
    const usdcTxHash = paymentSource === 'USDC' ? txHash! : ''
    const isTestTx = paymentSource === 'USDC' && usdcTxHash.startsWith('test_')

    // Layer 1: Idempotency-Key header replay.
    const idempotencyKey = request.headers['idempotency-key'] as string | undefined
    if (idempotencyKey) {
      try {
        const idempotencyResult = await checkIdempotencyKey(
          fastify.prisma,
          idempotencyKey,
          '/v1/buyer/compute/request',
          request.body,
        )
        if (!idempotencyResult.isNew && idempotencyResult.cachedResponse) {
          return reply
            .code(idempotencyResult.cachedResponse.statusCode)
            .header('X-Idempotency-Replay', 'true')
            .send(idempotencyResult.cachedResponse.body)
        }
      } catch (err) {
        return reply.code(409).send({
          error: 'Idempotency Conflict',
          message: err instanceof Error ? err.message : 'Idempotency key reused with different body',
        })
      }
    }

    // Layer 2: txHash dedup. If this user already submitted a compute
    // request with this txHash, return the existing one rather than
    // creating a duplicate. Solana tx hashes are one-shot financial
    // events; reusing one across two compute requests would always be a
    // bug regardless of idempotency-key handling. Skipped for
    // INTERNAL_BALANCE since we mint a per-request synthetic hash.
    if (paymentSource === 'USDC') {
      const storedTxHash = isTestTx ? `TEST:${usdcTxHash}` : usdcTxHash
      const existing = await fastify.prisma.computeRequest.findFirst({
        where: { userId, txHash: storedTxHash },
      })
      if (existing) {
        return reply.code(200).header('X-Idempotency-Replay', 'tx-hash').send({
          id: existing.id,
          gpuTier: existing.gpuTier,
          gpuCount: existing.gpuCount,
          durationDays: existing.durationDays,
          ratePerDay: existing.ratePerDay,
          totalCost: existing.totalCost,
          status: existing.status,
        })
      }
    }

    // Common create payload. Built once; the only difference between
    // USDC and INTERNAL_BALANCE is the initial txHash placeholder.
    const baseData = {
      userId,
      gpuTier: gpuTier as import('@a2e/database').GpuTier,
      gpuCount,
      durationDays: effectiveDurationDays,
      purpose,
      ratePerDay,
      totalCost,
      txConfirmed: true,
      status: 'PENDING' as const,
      paymentSource,
      // C2 wave 2: workload-type tag the allocator filters on. Default
      // MIXED keeps pre-wave-2 behavior (consumer tiers excluded);
      // INFERENCE unlocks consumer GPUs as candidates.
      workloadType: workloadType as import('@a2e/database').WorkloadType,
      // T5e: when true, allocator skips RunPod COMMUNITY tier and
      // routes only to dedicated supply (Lambda, RunPod SECURE,
      // internal operators). For benchmark-sensitive workloads.
      preferDedicatedTier,
      // T7: when true, allocator skips non-TEE suppliers (Lambda,
      // RunPod, internal nodes) and routes only to confidential
      // suppliers (Phala / io.net allow-listed / VoltageGPU).
      preferConfidential,
      // M3: persist tier so the routing engine + preemption worker
      // can read it. commitmentDays only stored for RESERVED rentals
      // (refund logic checks this when buyer terminates early).
      tier,
      commitmentDays: tier === 'RESERVED' ? commitmentDays ?? null : null,
      // M4.4: optional region constraint passed straight through to
      // the allocator. Empty string is normalized to null so the
      // allocator's `requiredRegion ? { region } : {}` branch picks
      // "Any" rather than filtering for the empty string.
      requiredRegion: requiredRegion?.trim() || null,
      // M5.10c: soft operator preference. May still be null if the
      // slug didn't resolve; allocator treats null as no preference.
      preferredOperatorId,
      // M6: buyer's SSH public key. The allocator preserves this on
      // the row; the heartbeat-response surfaces it to the agent at
      // provision time. Required for real (non-test-mode) rentals.
      sshPubKey: sshPubKey?.trim() || null,
      // Checkpoint Workspace restore: ownership + READY status already
      // verified above. Agent picks this up at provision time and pulls
      // the tarball from S3 into the rental's home dir before SSH opens.
      restoreCheckpointId: restoreCheckpointId || null,
    }

    let computeRequest
    if (paymentSource === 'INTERNAL_BALANCE' && internalSpendNodeRunnerId) {
      // Atomic: write the ComputeRequest + InternalSpend row + flip
      // the placeholder txHash to INTERNAL:<id> in one shot. If any
      // step fails, the spend is rolled back so the balance never
      // shrinks without a matching rental.
      computeRequest = await fastify.prisma.$transaction(async (tx) => {
        const created = await tx.computeRequest.create({
          data: { ...baseData, txHash: 'INTERNAL:PENDING' },
        })
        await tx.internalSpend.create({
          data: {
            nodeRunnerId: internalSpendNodeRunnerId,
            computeRequestId: created.id,
            amount: totalCost,
          },
        })
        return tx.computeRequest.update({
          where: { id: created.id },
          data: { txHash: `INTERNAL:${created.id}` },
        })
      })
    } else if (paymentSource === 'BUYER_BALANCE') {
      // Create the ComputeRequest with a placeholder txHash, debit
      // the balance (which writes the SPEND_RENTAL ledger entry), then
      // flip the txHash + link the balanceTransactionId so the refund
      // path can find both ends of the link. The debit is itself
      // transactional inside the service; if it throws (e.g. a race
      // dropped the balance below totalCost between the pre-check and
      // now), we delete the orphan request to keep state clean.
      const placeholder = await fastify.prisma.computeRequest.create({
        data: { ...baseData, txHash: 'BAL:PENDING' },
      })
      try {
        await debitBalance(fastify.prisma, {
          userId,
          amountUsd: totalCost,
          type: 'SPEND_RENTAL',
          description: `Rental ${gpuCount}x ${gpuTier} for ${effectiveDurationDays}d`,
          referenceId: placeholder.id,
        })
      } catch (err) {
        await fastify.prisma.computeRequest.delete({ where: { id: placeholder.id } })
        if (err instanceof InsufficientBalanceError) {
          return reply.code(402).send({
            error: 'Payment Required',
            message: err.message,
            required: err.requestedAmount,
            available: err.currentBalance,
            topupHint: 'Top up at /buyer/balance.',
          })
        }
        throw err
      }
      // Resolve the BalanceTransaction id we just created so we can
      // link it on the request. Looked up by (type, referenceId) which
      // is unique on that table.
      const ledgerEntry = await fastify.prisma.balanceTransaction.findFirst({
        where: { type: 'SPEND_RENTAL', referenceId: placeholder.id },
        select: { id: true },
      })
      computeRequest = await fastify.prisma.computeRequest.update({
        where: { id: placeholder.id },
        data: {
          txHash: `BAL:${placeholder.id}`,
          balanceTransactionId: ledgerEntry?.id ?? null,
        },
      })
    } else {
      // USDC path stays a single create — same shape as before
      // paymentSource shipped, so existing idempotency / dedup tests
      // and call patterns are unchanged.
      const storedTxHash = isTestTx ? `TEST:${usdcTxHash}` : usdcTxHash
      computeRequest = await fastify.prisma.computeRequest.create({
        data: { ...baseData, txHash: storedTxHash },
      })
    }

    // Notify admins (DB row + global notification:new WS event per admin)
    const admins = await fastify.prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    for (const admin of admins) {
      void createNotification(admin.id, 'COMPUTE_REQUEST_NEW', 'New Compute Request',
        `${gpuCount}x ${gpuTier} for ${durationDays} days ($${totalCost.toFixed(2)})`,
        '/compute')
    }

    // Real-time event so the admin dashboard can show a toast and bump
    // the sidebar badge without waiting for the next 30s poll. Distinct
    // from notification:new so the dashboard can subscribe just to
    // compute events without filtering every notification type.
    fastify.io?.emit('compute:request:new', {
      requestId: computeRequest.id,
      userId,
      gpuTier,
      gpuCount,
      durationDays,
      totalCost,
      timestamp: new Date().toISOString(),
    })

    const responseBody = {
      id: computeRequest.id,
      gpuTier, gpuCount, durationDays,
      ratePerDay, totalCost,
      status: computeRequest.status,
    }

    // Cache for idempotency-key replay
    if (idempotencyKey) {
      await storeIdempotencyResponse(
        fastify.prisma,
        idempotencyKey,
        '/v1/buyer/compute/request',
        request.body,
        201,
        responseBody,
      )
    }

    reply.code(201).send(responseBody)
  })

  /**
   * GET /v1/buyer/compute/requests — List buyer's requests
   */
  fastify.get('/v1/buyer/compute/requests', async (request, reply) => {
    const parsed = listSchema.safeParse(request.query)
    const { page, limit, status } = parsed.success ? parsed.data : { page: 1, limit: 20, status: undefined }

    const where: Record<string, unknown> = { userId: request.user!.userId }
    if (status) where.status = status

    const [requests, total] = await Promise.all([
      fastify.prisma.computeRequest.findMany({
        where, orderBy: { requestedAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      fastify.prisma.computeRequest.count({ where }),
    ])

    reply.send({ requests, total, page, limit, pages: Math.ceil(total / limit) })
  })

  /**
   * GET /v1/buyer/compute/requests/:id — Request detail (includes SSH when ACTIVE)
   */
  fastify.get('/v1/buyer/compute/requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId: request.user!.userId },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })

    // Only expose SSH details when ACTIVE
    const result: Record<string, unknown> = { ...cr }
    if (cr.status !== 'ACTIVE') {
      result.sshHost = null
      result.sshPort = null
      result.sshUsername = null
      result.sshPassword = null
    }

    reply.send({ request: result })
  })

  /**
   * GET /v1/buyer/compute/active — Active allocations with SSH
   */
  fastify.get('/v1/buyer/compute/active', async (request, reply) => {
    const active = await fastify.prisma.computeRequest.findMany({
      where: { userId: request.user!.userId, status: 'ACTIVE' },
      orderBy: { activatedAt: 'desc' },
    })

    reply.send({ allocations: active })
  })

  /**
   * PATCH /v1/buyer/compute/requests/:id/cancel
   *
   * Buyer-initiated cancellation of a PENDING request. Nothing was
   * provisioned yet so the refund is the full totalCost, routed back
   * to the payment source:
   *
   *   - BUYER_BALANCE: a REFUND_RENTAL credit reverses the SPEND_RENTAL
   *     debit. Idempotent via (type, referenceId=cancel:<id>).
   *   - USDC: the buyer's USDC payment landed in the platform admin
   *     wallet at topup time, so we owe them an equivalent credit. We
   *     credit to the buyer's internal balance (REFUND_RENTAL) instead
   *     of sending USDC back on-chain — same payout shape as terminate's
   *     INTERNAL_BALANCE fallback, and the buyer can withdraw it to
   *     Phantom via /buyer/balance when they want.
   *   - INTERNAL_BALANCE: reverse the InternalSpend row so the
   *     node-runner's spend ledger is consistent.
   *   - STRIPE_DIRECT: deferred — needs the Stripe refund API. For now
   *     we still credit balance so the buyer is whole; an admin can
   *     issue the Stripe refund + zero the balance credit if needed.
   *
   * Idempotent: status guard on the UPDATE prevents a double-refund if
   * two cancel clicks race, AND the BalanceTransaction unique on
   * (type, referenceId) prevents a credit double-write even if the
   * status transition somehow re-fires.
   */
  fastify.patch('/v1/buyer/compute/requests/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'PENDING') {
      return reply.code(400).send({ error: 'Can only cancel PENDING requests' })
    }

    // Status-guarded transition. If a concurrent cancel beat us here,
    // updated.count is 0 and we skip the refund — the other request is
    // responsible for it.
    const updated = await fastify.prisma.computeRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    if (updated.count === 0) {
      return reply.send({ id, status: 'CANCELLED', alreadyCancelled: true })
    }

    // Refund routing. Catches and logs but does NOT roll back the
    // CANCELLED status — the row is still cancelled, and a separate
    // operator action can recover money if the refund leg fails.
    let refundIssued = false
    let refundDestination: 'balance' | 'internal_spend_reverted' | 'none' = 'none'
    try {
      if (cr.paymentSource === 'BUYER_BALANCE' || cr.paymentSource === 'USDC' || cr.paymentSource === 'STRIPE_DIRECT') {
        await creditBalance(fastify.prisma, {
          userId,
          amountUsd: cr.totalCost,
          type: 'REFUND_RENTAL',
          description: `Refund for cancelled ${cr.gpuCount}x ${cr.gpuTier} rental`,
          referenceId: `cancel:${id}`,
        })
        refundIssued = true
        refundDestination = 'balance'
      } else if (cr.paymentSource === 'INTERNAL_BALANCE') {
        await fastify.prisma.internalSpend.deleteMany({
          where: { computeRequestId: id },
        })
        refundIssued = true
        refundDestination = 'internal_spend_reverted'
      }
    } catch (err) {
      // Duplicate ref means the refund already landed (idempotent retry).
      const isDuplicate = err instanceof Error && err.name === 'DuplicateTransactionError'
      if (!isDuplicate) {
        fastify.log.error(
          { err, id, paymentSource: cr.paymentSource, totalCost: cr.totalCost },
          'cancel refund failed; row is CANCELLED but money still owed to buyer',
        )
      } else {
        refundIssued = true
        refundDestination = 'balance'
      }
    }

    reply.send({
      id,
      status: 'CANCELLED',
      refundIssued,
      refundDestination,
      refundAmountUsd: refundIssued ? cr.totalCost : 0,
    })
  })

  /**
   * POST /v1/buyer/compute/requests/stripe/checkout
   *
   * T3.1: direct-pay rental flow. Buyer skips the balance top-up step
   * by paying for the rental in one click. We compute totalCost from
   * the same pricing logic the regular submit endpoint uses, create
   * a Stripe Checkout Session with the full payload in metadata, and
   * return the hosted-checkout URL. The webhook handler creates the
   * ComputeRequest with paymentSource=STRIPE_DIRECT once Stripe
   * confirms payment server-side.
   *
   * NOT a substitute for the regular flow: USDC / BUYER_BALANCE /
   * INTERNAL_BALANCE still work. This is just a one-click card path
   * for buyers who don't want to manage a balance.
   *
   * Refund nuance: if the buyer terminates early, the existing
   * terminate route refunds via Solana / balance crediting. For
   * STRIPE_DIRECT rentals, that path needs the Stripe Refunds API
   * instead (refund the original PaymentIntent prorated to the
   * unused portion). That stitch lands in a follow-up; for v1 of
   * T3.1, early-terminated STRIPE_DIRECT rentals fall back to a
   * BuyerBalance credit (the buyer gets compute credit, not a card
   * refund). Flagged for the user during onboarding.
   */
  // requestSchema is wrapped in refines (ZodEffects), which Zod 3
  // doesn't let us .pick() from. Define the Stripe-checkout shape
  // standalone with just the fields we need to build the rental.
  const stripeCheckoutSchema = z.object({
    gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']),
    gpuCount: z.number().int().min(1).max(64).default(1),
    durationDays: z.number().int().min(1).max(365).default(7),
    tier: z.enum(['ON_DEMAND', 'SPOT', 'RESERVED']).default('ON_DEMAND'),
    workloadType: z.enum(['INFERENCE', 'TRAINING', 'MIXED']).default('MIXED'),
    // Mirror requestSchema: portal sends these for STRIPE_DIRECT flows
    // too. Prior schema dropped them silently — Stripe-paid rentals
    // never carried the dedicated/confidential flags forward. Adding
    // them here makes the Stripe and balance/USDC paths behave the
    // same, AND lets the waitlist gate below work on Stripe requests.
    preferDedicatedTier: z.boolean().default(false),
    preferConfidential: z.boolean().default(false),
    commitmentDays: z.number().int().refine(d => [7, 30, 90].includes(d)).optional(),
    requiredRegion: z.string().max(64).optional().nullable(),
    preferredOperatorSlug: z.string().max(120).optional().nullable(),
    purpose: z.string().max(500).optional(),
    sshPubKey: z.string().min(20).max(8192).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
  })

  fastify.post('/v1/buyer/compute/requests/stripe/checkout', async (request, reply) => {
    if (!isStripeConfigured()) {
      return reply.code(503).send({
        error: 'stripe_not_configured',
        message: 'Card payments are not enabled on this deploy.',
      })
    }

    const parsed = stripeCheckoutSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.format() })
    }
    const body = parsed.data
    const userId = request.user!.userId

    // Defense-in-depth: same waitlist gate as the regular submit path.
    // Block Stripe checkout sessions for confidential requests when
    // CONFIDENTIAL_COMPUTE_UI_MODE != active so a buyer doesn't pay
    // the card processor for compute we can't deliver.
    if (body.preferConfidential) {
      const mode = getConfidentialComputeUiMode()
      if (mode !== 'active') {
        return reply.code(422).send({
          error: 'confidential_compute_waitlisted',
          message:
            'Confidential compute is temporarily waitlisted while we onboard suppliers. Join the waitlist instead — no payment is taken.',
          uiMode: mode,
        })
      }
    }

    // Compute totalCost the same way the regular submit path does:
    // GPU_TIER_CONFIG.retailRate is per-day per-GPU. SPOT discount and
    // RESERVED discount apply post-base. (commitmentDays is informational
    // for now; the discount is rolled into the rate the buyer sees.)
    const config = GPU_TIER_CONFIG[body.gpuTier as keyof typeof GPU_TIER_CONFIG]
    if (!config) {
      return reply.code(400).send({ error: 'unsupported_tier' })
    }
    const baseRatePerDay = config.retailRate
    // Reuse the shared multiplier helpers so this path can never
    // diverge from the primary submit path again. Previously this
    // block parsed SPOT_DISCOUNT_PCT differently (`/100`) which made
    // the same env value mean different things in the two paths;
    // the helper enforces a single convention. Floor applied after
    // composition so Stripe-direct rentals respect the same minimum.
    const ratePerDay = applyPriceFloor(
      baseRatePerDay
        * tierPricingMultiplier(body.tier)
        * workloadPricingMultiplier(body.workloadType, body.gpuTier),
      body.gpuTier,
    )
    const totalCost = Number((ratePerDay * body.gpuCount * body.durationDays).toFixed(2))
    if (totalCost < 1) {
      return reply.code(400).send({ error: 'amount_too_small', message: 'Rental total must be at least $1.00.' })
    }

    // Resolve operator slug -> id BEFORE creating the session so an
    // invalid slug fails fast at $0 instead of forcing the buyer to
    // pay first and then discover the slug is bad.
    let preferredOperatorId: string | null = null
    if (body.preferredOperatorSlug) {
      const op = await fastify.prisma.nodeRunner.findFirst({
        where: { slug: body.preferredOperatorSlug },
        select: { id: true },
      })
      if (!op) {
        return reply.code(400).send({ error: 'unknown_operator', message: `No operator found with slug ${body.preferredOperatorSlug}` })
      }
      preferredOperatorId = op.id
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    })

    const PORTAL = process.env.PORTAL_URL ?? 'https://user.tokenos.ai'
    try {
      const session = await createDirectRentalCheckoutSession({
        userId,
        email: user?.email ?? null,
        amountUsd: totalCost,
        gpuTier: body.gpuTier,
        gpuCount: body.gpuCount,
        durationDays: body.durationDays,
        ratePerDay,
        workloadType: body.workloadType,
        tier: body.tier,
        commitmentDays: body.commitmentDays ?? null,
        requiredRegion: body.requiredRegion ?? null,
        preferredOperatorId,
        purpose: body.purpose ?? null,
        successUrl: body.successUrl ?? `${PORTAL}/buyer/requests?stripe=success`,
        cancelUrl: body.cancelUrl ?? `${PORTAL}/buyer/request?stripe=cancelled`,
      })
      // sshPubKey can exceed Stripe's 500-char metadata cap (RSA keys
      // routinely do). Stash on a dedicated scratch table keyed by
      // the Stripe Session id; the webhook reads + deletes it after
      // creating the ComputeRequest. A cleanup job prunes any
      // abandoned rows after 24h.
      if (body.sshPubKey) {
        await fastify.prisma.stripeCheckoutContext.create({
          data: {
            sessionId: session.id,
            userId,
            payload: { sshPubKey: body.sshPubKey } as unknown as object,
          },
        })
      }
      reply.send({
        sessionId: session.id,
        url: session.url,
        amountUsd: totalCost,
        ratePerDay,
      })
    } catch (err) {
      fastify.log.error({ err, userId }, 'createDirectRentalCheckoutSession failed')
      return reply.code(500).send({ error: 'stripe_checkout_failed', message: (err as Error).message })
    }
  })

  /**
   * GET /v1/buyer/compute/requests/:id/external-credentials
   *
   * T5c: surface the Lambda-provisioned SSH credentials to the buyer
   * when the rental was served via the inbound supply fallback. The
   * private key is decrypted on-demand here and returned over the
   * caller's HTTPS session; it never goes to logs or persists to any
   * other table.
   *
   * Returns 404 when the rental has no ExternalRental row (i.e. it
   * was served from internal nodes — the existing SSH section in the
   * page reads sshHost/sshPassword from ComputeRequest directly).
   *
   * Returns 409 when the rental is still PROVISIONING_EXTERNAL (no
   * sshHost yet); the page polls again every 5s while the badge
   * shows "Provisioning on Lambda".
   *
   * Auth: standard buyer JWT, ownership-checked via the request's
   * userId.
   */
  fastify.get('/v1/buyer/compute/requests/:id/external-credentials', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })

    const ext = await fastify.prisma.externalRental.findUnique({
      where: { computeRequestId: id },
      select: {
        provider: true,
        status: true,
        sshHost: true,
        sshPort: true,
        sshUsername: true,
        sshPrivateKeyEnc: true,
        providerInstanceType: true,
        providerRegion: true,
        launchedAt: true,
        attestationUrl: true,
        attestationFetchedAt: true,
      },
    })
    if (!ext) return reply.code(404).send({ error: 'No external rental for this request' })

    if (!ext.sshHost) {
      return reply.code(409).send({
        error: 'External rental is still provisioning',
        status: ext.status,
        provider: ext.provider,
        instanceType: ext.providerInstanceType,
        region: ext.providerRegion,
      })
    }

    let sshPrivateKey: string
    try {
      sshPrivateKey = decryptPrivateKey(ext.sshPrivateKeyEnc)
    } catch (err) {
      fastify.log.error({ err, requestId: id }, 'decryptPrivateKey failed')
      return reply.code(500).send({ error: 'Failed to decrypt SSH key (check SSH_KEY_ENCRYPTION_KEY env)' })
    }

    reply.send({
      provider: ext.provider,
      status: ext.status,
      sshHost: ext.sshHost,
      sshPort: ext.sshPort,
      sshUsername: ext.sshUsername,
      sshPrivateKey,
      instanceType: ext.providerInstanceType,
      region: ext.providerRegion,
      launchedAt: ext.launchedAt,
      // T7: cryptographic attestation report. Only populated for
      // confidential providers (VoltageGPU / Phala / io.net-allow-
      // listed); null for Lambda / RunPod / internal nodes.
      attestationUrl: ext.attestationUrl,
      attestationFetchedAt: ext.attestationFetchedAt,
    })
  })

  /**
   * POST /v1/buyer/compute/requests/:id/terminate
   *
   * Buyer-initiated early termination for an ACTIVE rental. Computes
   * the prorated refund (totalCost - accruedCost), attempts to refund
   * via the configured Solana payer (dev mode returns a DEV_ tx hash;
   * live mode requires the payer key — see SOLANA_LIVE_SETUP.md), and
   * transitions the rental to COMPLETED. Releases the assigned nodes.
   *
   * Why a separate route from /cancel: cancel is for PENDING (no money
   * has moved yet); terminate is for ACTIVE rentals where minutes have
   * already accrued and a refund needs to flow back.
   */
  fastify.post('/v1/buyer/compute/requests/:id/terminate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'ACTIVE') {
      return reply.code(400).send({ error: `Cannot terminate: status is ${cr.status}` })
    }

    // Final accrual snapshot. The meter (60s tick) may not have caught
    // up to wall-clock-now yet; recompute on the spot so the refund
    // reflects the exact second the buyer clicked terminate.
    const ratePerMinute = cr.ratePerMinute ?? (cr.ratePerDay * cr.gpuCount) / (24 * 60)
    const elapsedMs = cr.activatedAt ? Date.now() - cr.activatedAt.getTime() : 0
    const elapsedMinutes = Math.floor(elapsedMs / 60000)
    const maxMinutes = cr.durationDays * 24 * 60
    const finalMinutes = Math.min(elapsedMinutes, maxMinutes)
    const finalAccrued = Math.min(
      Number((finalMinutes * ratePerMinute).toFixed(4)),
      cr.totalCost,
    )
    // M3: RESERVED tier rentals are non-refundable on early termination
    // (commitment is the commitment, like AWS Reserved Instances). Buyer
    // chose the discount in exchange for locking in the duration; if
    // they leave early, they paid for the full commitment regardless.
    // ON_DEMAND and SPOT both refund the unused portion as before.
    const refundAmount = cr.tier === 'RESERVED'
      ? 0
      : Math.max(0, Number((cr.totalCost - finalAccrued).toFixed(4)))

    // Refund flow: only attempt if the user has a payable wallet on file.
    // We pull from User.walletAddress; buyers can set this in /v1/buyer/settings.
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    })

    let refundTxHash: string | null = null
    // SKIPPED_NO_WALLET kept in the type union for backward compat with
    // historical rows that already record this status. New terminations
    // never produce it; the no-wallet path now auto-credits the buyer
    // balance and reports CREDITED_TO_BALANCE.
    let refundStatus:
      | 'SENT'
      | 'CREDITED_TO_BALANCE'
      | 'SKIPPED_NO_WALLET'
      | 'SKIPPED_ZERO'
      | 'SKIPPED_RESERVED'
      | 'INTERNAL_REBATED'
      | 'FAILED' = 'SKIPPED_ZERO'
    let refundError: string | null = null

    if (cr.tier === 'RESERVED') {
      // Distinct status from SKIPPED_ZERO so the buyer notification +
      // admin note explain the commitment-forfeit semantics, not just
      // "no refund due."
      refundStatus = 'SKIPPED_RESERVED'
    } else if (refundAmount <= 0) {
      refundStatus = 'SKIPPED_ZERO'
    } else if (cr.paymentSource === 'INTERNAL_BALANCE') {
      // Money never left the platform — rebate the spend ledger row
      // down to the actual accrued cost. Operator's available balance
      // reflects the new spend on the next balance-breakdown call.
      // No Solana hop, no refund tx hash, no chance of refund failure.
      try {
        await fastify.prisma.internalSpend.update({
          where: { computeRequestId: id },
          data: { amount: finalAccrued },
        })
        refundStatus = 'INTERNAL_REBATED'
      } catch (err) {
        // If somehow the spend row is missing (data race, manual DB
        // edit), don't block termination — log and continue. The
        // operator can still see the rental ended; admin can
        // reconcile via the audit log.
        refundStatus = 'FAILED'
        refundError = err instanceof Error ? err.message : 'Internal spend rebate failed'
        fastify.log.error({ err, requestId: id }, 'InternalSpend rebate failed during terminate')
      }
    } else if (!user?.walletAddress) {
      // No wallet on file -> credit the buyer's portal balance instead
      // of leaving the refund unpaid. Previously this returned
      // SKIPPED_NO_WALLET and the money sat with the platform until an
      // admin ran reissue-skipped-refunds.ts. Now the buyer sees the
      // refund land in their balance immediately, and they can spend
      // it on the next rental or withdraw later via a wallet flow.
      try {
        await creditBalance(fastify.prisma, {
          userId,
          amountUsd: refundAmount,
          type: 'REFUND_RENTAL',
          description: `Refund for terminated rental (no wallet on file — credited to balance)`,
          referenceId: id,
        })
        refundStatus = 'CREDITED_TO_BALANCE'
      } catch (err) {
        // Credit failure is rare (DB constraint, duplicate referenceId)
        // — fall through to FAILED so the admin sees it in the audit
        // trail and the buyer-facing notification reflects the
        // problem honestly instead of claiming "credited."
        refundStatus = 'FAILED'
        refundError = err instanceof Error ? err.message : 'Balance credit failed'
        fastify.log.error({ err, requestId: id }, 'Refund balance credit failed during terminate')
      }
    } else {
      try {
        const solanaConfig = await getSolanaConfig(fastify.prisma)
        const result = await processPayment(solanaConfig, user.walletAddress, refundAmount, 'USDC')
        if (result.success && result.txHash) {
          refundTxHash = result.txHash
          refundStatus = 'SENT'
        } else {
          // On-chain send failed (RPC down, payer wallet empty, etc.)
          // -> fall back to a balance credit instead of leaving the
          // refund stranded as FAILED. Buyer gets their money one way
          // or another.
          try {
            await creditBalance(fastify.prisma, {
              userId,
              amountUsd: refundAmount,
              type: 'REFUND_RENTAL',
              description: `Refund for terminated rental (USDC send failed: ${result.error ?? 'unknown'} — credited to balance)`,
              referenceId: id,
            })
            refundStatus = 'CREDITED_TO_BALANCE'
            refundError = result.error ?? 'USDC send failed; fell back to balance credit'
          } catch (creditErr) {
            refundStatus = 'FAILED'
            refundError = `USDC send failed (${result.error}) AND balance credit failed (${creditErr instanceof Error ? creditErr.message : 'unknown'})`
            fastify.log.error({ err: creditErr, requestId: id }, 'Both USDC refund and balance credit failed during terminate')
          }
        }
      } catch (err) {
        refundStatus = 'FAILED'
        refundError = err instanceof Error ? err.message : 'Refund processing error'
        fastify.log.error({ err, requestId: id }, 'Refund failed during terminate')
      }
    }

    // Atomically: mark COMPLETED, freeze final accrual, release nodes,
    // bump trust signals so the eligibility engine learns this buyer
    // followed through. Refund tx hash recorded in adminNote so the
    // operator can audit later.
    const completedAt = new Date()
    await fastify.prisma.$transaction([
      fastify.prisma.computeRequest.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt,
          minutesUsed: finalMinutes,
          accruedCost: finalAccrued,
          adminNote: refundTxHash
            ? `Buyer terminated. Refund $${refundAmount} sent: ${refundTxHash}`
            : `Buyer terminated. Refund status: ${refundStatus}${refundError ? ` (${refundError})` : ''}`,
          // Clear ephemeral SSH so leaked credentials become useless.
          sshSessionToken: null,
          sshSessionTokenExpiresAt: null,
          // Launch-blocker #2: signal agent teardown. The node will
          // return to the idle pool only after the agent's TERMINATED
          // callback (or the reaper's 10-minute failsafe) — until
          // then the buyer's installed pubkey can't outlive the rental.
          sshSessionStatus: 'TERMINATING',
        },
      }),
      fastify.prisma.user.update({
        where: { id: userId },
        data: { successfulRentalCount: { increment: 1 }, lastRentalAt: completedAt },
      }),
    ])

    // Track 5 / M0.3: split the actually-billed revenue 3 ways
    // (operator cost+50% net, staking 25%, treasury 25%) when
    // REVENUE_SPLIT_ENABLED is true. Uses the post-refund amount
    // (finalAccrued) as gross — operators only get a cut of what
    // the buyer actually paid for. No-op when the kill switch is
    // OFF. Logs but doesn't throw on failure so the buyer's
    // terminate response is never blocked by the split.
    try {
      await creditCompletedRental(fastify.prisma, {
        computeRequestId: id,
        grossOverrideUsd: finalAccrued,
      })
    } catch (err) {
      fastify.log.error({ err, requestId: id }, 'creditCompletedRental failed during terminate')
    }

    // T5b: if this was a Lambda-provisioned rental, stop billing on
    // the provider side. Wrapped so a termination failure can't
    // block the response to the buyer.
    try {
      // T6: dispatch to the right provider (LAMBDA / RUNPOD / future).
      // Was hardcoded to terminateLambdaRental which silently leaked
      // billing on RunPod rentals before T5e. The dispatcher routes
      // by ExternalRental.provider so a single call covers every
      // supplier.
      await terminateExternalRentalForRequest(
        fastify.prisma,
        id,
        `buyer terminated rental (${refundStatus})`,
      )
    } catch (err) {
      if (err instanceof UnknownProviderError) {
        fastify.log.error(
          { err, requestId: id },
          'PROVIDER LEAK during buyer terminate — manual ops needed to terminate on provider dashboard',
        )
      } else {
        fastify.log.error({ err, requestId: id }, 'external terminate failed during buyer terminate')
      }
    }

    void createNotification(
      userId,
      'COMPUTE_COMPLETED',
      'Rental Ended',
      refundStatus === 'SENT'
        ? `Your rental ended. Refund of $${refundAmount.toFixed(2)} sent to your wallet.`
        : refundStatus === 'CREDITED_TO_BALANCE'
          ? `Your rental ended. $${refundAmount.toFixed(2)} credited to your portal balance.`
          : refundStatus === 'INTERNAL_REBATED'
            ? `Your rental ended. $${refundAmount.toFixed(2)} credited back to your operator balance.`
            : refundStatus === 'SKIPPED_RESERVED'
              ? `Your RESERVED rental ended early. Per your ${cr.commitmentDays}-day commitment, no refund applies.`
              : `Your rental ended. ${refundStatus === 'SKIPPED_ZERO' ? 'No refund due.' : 'Refund failed — admin notified.'}`,
      `/buyer/requests/${id}`,
    )

    // Notify all admins so the bell + the dashboard's notification feed
    // surface the termination. The compute:terminated WS event below
    // also triggers a toast on any open admin tab in real-time.
    const admins = await fastify.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    })
    const buyerLabel = user?.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'a buyer'
    for (const admin of admins) {
      void createNotification(
        admin.id,
        'COMPUTE_COMPLETED',
        'Rental Terminated',
        `${buyerLabel} terminated their ${cr.gpuCount}x ${cr.gpuTier} rental early. ` +
          `Accrued $${finalAccrued.toFixed(2)}, refund $${refundAmount.toFixed(2)} (${refundStatus}).`,
        '/compute',
      )
    }

    fastify.io?.emit('compute:terminated', {
      requestId: id,
      userId,
      gpuTier: cr.gpuTier,
      gpuCount: cr.gpuCount,
      finalMinutes,
      finalAccrued,
      refundAmount,
      refundStatus,
      refundTxHash,
      timestamp: completedAt.toISOString(),
    })

    reply.send({
      id,
      status: 'COMPLETED',
      finalMinutes,
      finalAccrued,
      refundAmount,
      refundStatus,
      refundTxHash,
      refundError,
    })
  })

  /**
   * POST /v1/buyer/compute/requests/:id/checkpoint — M3
   *
   * Buyer-initiated workspace snapshot. Marks the rental's
   * checkpointStatus = REQUESTED so the agent picks it up on the next
   * heartbeat poll, packages the workspace, uploads to S3, and reports
   * back via POST /v1/agent/checkpoints. Re-triggering before the
   * previous one completes is allowed (overwrites — buyer's intent is
   * always "snapshot the current state").
   *
   * Note: agent-side S3 upload code is part of the deferred Project 2
   * (agent ephemeral SSH manager) work. The API + DB + buyer UI are
   * ready; once the agent ships, the full loop closes automatically.
   */
  fastify.post('/v1/buyer/compute/requests/:id/checkpoint', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
      select: { id: true, status: true, checkpointStatus: true },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'ACTIVE') {
      return reply.code(400).send({
        error: `Can only checkpoint ACTIVE rentals (current: ${cr.status})`,
      })
    }

    await fastify.prisma.computeRequest.update({
      where: { id },
      data: {
        checkpointStatus: 'REQUESTED',
        checkpointRequestedAt: new Date(),
        checkpointError: null, // clear prior error if re-trying
      },
    })

    fastify.io?.emit('checkpoint:requested', {
      requestId: id,
      userId,
      timestamp: new Date().toISOString(),
    })

    return reply.code(202).send({
      id,
      checkpointStatus: 'REQUESTED',
      message: 'Checkpoint requested. Agent will package + upload your workspace.',
    })
  })

  /**
   * POST /v1/buyer/compute/requests/:id/rate — M3
   *
   * Buyer rates the operator after a rental completes. Score 1-5 stars +
   * optional comment ≤500 chars. One rating per rental (unique on
   * computeRequestId). Default moderationStatus = PENDING; admin
   * moderates before the rating influences operator's reputation score
   * or appears on their public vanity profile.
   */
  fastify.post('/v1/buyer/compute/requests/:id/rate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const ratingSchema = z.object({
      score: z.number().int().min(1).max(5),
      comment: z.string().max(500).optional(),
    })
    const parsed = ratingSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map(e => e.message).join(', '),
      })
    }

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
      select: { id: true, status: true, allocatedNodeIds: true },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })
    if (cr.status !== 'COMPLETED') {
      return reply.code(400).send({ error: `Can only rate COMPLETED rentals (current: ${cr.status})` })
    }

    // Find the operator (NodeRunner) via the first allocated node.
    // If allocatedNodeIds is empty (rejected/cancelled paths), there's
    // no operator to rate — should never happen for COMPLETED rentals.
    const headNodeId = cr.allocatedNodeIds[0]
    if (!headNodeId) {
      return reply.code(400).send({ error: 'Cannot rate a rental with no allocated node' })
    }
    const node = await fastify.prisma.node.findUnique({
      where: { id: headNodeId },
      select: { nodeRunnerId: true },
    })
    if (!node?.nodeRunnerId) {
      return reply.code(400).send({ error: 'Allocated node has no operator (BYOG admin-onboarded)' })
    }

    // Upsert: re-rating overwrites + resets to PENDING for re-moderation
    const rating = await fastify.prisma.rating.upsert({
      where: { computeRequestId: id },
      create: {
        computeRequestId: id,
        buyerId: userId,
        nodeRunnerId: node.nodeRunnerId,
        score: parsed.data.score,
        comment: parsed.data.comment,
        moderationStatus: 'PENDING',
      },
      update: {
        score: parsed.data.score,
        comment: parsed.data.comment,
        moderationStatus: 'PENDING',
        moderatedAt: null,
        moderationNote: null,
      },
    })

    // Notify all admins so the moderation queue gets attention promptly.
    const admins = await fastify.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true },
    })
    for (const admin of admins) {
      void createNotification(
        admin.id,
        'COMPUTE_COMPLETED',
        'New Rating Pending Review',
        `${parsed.data.score}-star rating submitted for an operator. Review in Ratings queue.`,
        '/ratings',
      )
    }

    fastify.io?.emit('rating:new', {
      ratingId: rating.id,
      computeRequestId: id,
      score: rating.score,
      timestamp: new Date().toISOString(),
    })

    return reply.code(201).send({
      id: rating.id,
      score: rating.score,
      moderationStatus: rating.moderationStatus,
    })
  })

  /**
   * GET /v1/buyer/compute/requests/:id/rating — fetch existing rating
   * for a rental (so the buyer rate page can show "you've already rated
   * this" instead of letting them re-rate by default).
   */
  fastify.get('/v1/buyer/compute/requests/:id/rating', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id, userId },
      select: { id: true },
    })
    if (!cr) return reply.code(404).send({ error: 'Request not found' })

    const rating = await fastify.prisma.rating.findUnique({
      where: { computeRequestId: id },
      select: { id: true, score: true, comment: true, moderationStatus: true, createdAt: true },
    })
    return reply.send({ rating })
  })

  /**
   * PATCH /v1/buyer/settings
   *
   * Updates user.email and/or user.walletAddress. walletAddress goes
   * through a sanity check that rejects well-known token mint pubkeys
   * (USDC, USDT, etc.) — users sometimes copy a mint from a token
   * detail page thinking it's the receiving address, which silently
   * breaks future refund delivery (USDC sent to a mint address is
   * effectively burned). Better to reject on input than discover the
   * mistake when a refund is owed.
   */
  fastify.patch('/v1/buyer/settings', async (request, reply) => {
    const { email, walletAddress } = request.body as { email?: string; walletAddress?: string }

    if (walletAddress) {
      const trimmed = walletAddress.trim()

      // Basic base58 + length check. Real Solana addresses are 32-44
      // base58 chars; this is the first cheap gate before anything fancier.
      if (trimmed.length < 32 || trimmed.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
        return reply.code(400).send({
          error: 'invalid_wallet',
          message: 'Wallet address must be a valid Solana base58 address (32-44 chars).',
        })
      }

      // Blocklist of well-known SPL token MINT pubkeys. These are not
      // wallets — sending USDC to them is a one-way trip. Users
      // sometimes paste these from a Solscan token page or Phantom
      // token detail screen by mistake.
      const KNOWN_MINTS: Record<string, string> = {
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC (mainnet mint)',
        '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'USDC (devnet mint)',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT (mainnet mint)',
        'So11111111111111111111111111111111111111112': 'Wrapped SOL mint',
      }
      if (KNOWN_MINTS[trimmed]) {
        return reply.code(400).send({
          error: 'invalid_wallet',
          message:
            `That address is the ${KNOWN_MINTS[trimmed]}, not a wallet. ` +
            `Open Phantom and copy YOUR wallet address (under your account name) instead.`,
        })
      }
    }

    const updated = await fastify.prisma.user.update({
      where: { id: request.user!.userId },
      data: {
        ...(email ? { email } : {}),
        ...(walletAddress ? { walletAddress: walletAddress.trim() } : {}),
      },
    })

    reply.send({ id: updated.id, email: updated.email, walletAddress: updated.walletAddress })
  })
}
