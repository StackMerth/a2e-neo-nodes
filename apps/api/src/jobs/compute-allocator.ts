/**
 * M2 / B1: Auto-allocator worker (the operator-killer).
 *
 * Watches every PENDING ComputeRequest where the buyer's payment has
 * confirmed on-chain (txConfirmed=true) and decides what happens next:
 *
 *   1. Run eligibility rules. If held, set status=WAITLISTED and write
 *      flags so the admin Needs Review queue knows why. Stop here.
 *
 *   2. Find idle internal nodes matching the requested GPU tier. If
 *      supply is insufficient, leave the request in PENDING — the next
 *      tick retries automatically when nodes come online.
 *
 *   3. Mint an ephemeral SSH session token, mark the nodes assigned,
 *      transition the request to ALLOCATED, set ratePerMinute (so the
 *      per-minute meter has its multiplier ready), notify the buyer,
 *      and emit a websocket event so the dashboard updates live.
 *
 * The worker runs on a 10-second cadence. That's the worst-case latency
 * a buyer sees between paying and getting SSH access; in practice the
 * Solana webhook (M2.3) flips txConfirmed within ~3s of the on-chain
 * confirmation, so end-to-end pay-to-prompt is sub-15s.
 *
 * Idempotency: every status transition uses an updateMany with a status
 * predicate so two concurrent ticks can never double-allocate the same
 * request. If a tick races, one wins, the other no-ops.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { isRefused, recordRefusal } from '../services/provider/refusal-cache.js'

// Module-level Redis client for refusal-cache lookups. Same pattern
// as runpod-capacity-watcher.ts; picks up REDIS_URL from env. When
// a provider+tier was recently refused (within PROVIDER_REFUSAL_TTL_SECONDS,
// default 10 min), the matching tryXxxFallback short-circuits early
// so the allocator skips to the next candidate without round-tripping
// the upstream API.
const REFUSAL_REDIS = new Redis(
  process.env.REDIS_URL ?? 'redis://localhost:6379',
  {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
)
import type { PrismaClient, ComputeRequest, User, GpuTier } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { evaluateEligibility } from '../services/allocation/eligibility.js'
import { mintSshSession } from '../services/allocation/ssh-session.js'
import { createNotification, notifyAdmins } from '../services/notification/service.js'
import { planClusterMesh } from '../services/provisioning/wireguard-mesh.js'
import { isLambdaConfigured } from '../services/inbound/lambda-adapter.js'
import { isKeyEncryptionConfigured } from '../services/inbound/key-encryption.js'
import {
  lambdaTypeForTier,
  fitsSingleLambdaInstance,
} from '../services/inbound/tier-mapping.js'
import { provisionLambdaRental } from '../services/inbound/lambda-provision.js'
import { isRunPodConfigured } from '../services/inbound/runpod-adapter.js'
import {
  runPodTypeForTier,
  fitsSingleRunPodPod,
} from '../services/inbound/runpod-tier-mapping.js'
import { provisionRunPodRental } from '../services/inbound/runpod-provision.js'
import { isPhalaConfigured } from '../services/inbound/phala-adapter.js'
import {
  phalaTypeForTier,
  fitsSinglePhalaCvm,
} from '../services/inbound/phala-tier-mapping.js'
import { provisionPhalaRental } from '../services/inbound/phala-provision.js'
import { isIoNetConfigured } from '../services/inbound/ionet-adapter.js'
import {
  ioNetTypeForTier,
  fitsSingleIoNetVm,
} from '../services/inbound/ionet-tier-mapping.js'
import { provisionIoNetRental } from '../services/inbound/ionet-provision.js'
import { isVoltageGpuConfigured } from '../services/inbound/voltagegpu-adapter.js'
import {
  voltageGpuTypeForTier,
  fitsSingleVoltageGpuPod,
} from '../services/inbound/voltagegpu-tier-mapping.js'
import { provisionVoltageGpuRental } from '../services/inbound/voltagegpu-provision.js'
import {
  isVastAiConfigured,
  isVastAiAllocatorEnabled,
} from '../services/inbound/vastai-adapter.js'
import {
  vastAiTypeForTier,
  fitsSingleVastAiHost,
} from '../services/inbound/vastai-tier-mapping.js'
import { provisionVastAiRental } from '../services/inbound/vastai-provision.js'
import {
  isTensorDockConfigured,
  isTensorDockAllocatorEnabled,
} from '../services/inbound/tensordock-adapter.js'
import {
  tensorDockTypeForTier,
  fitsSingleTensorDockHost,
} from '../services/inbound/tensordock-tier-mapping.js'
import { provisionTensorDockRental } from '../services/inbound/tensordock-provision.js'
import {
  isShadeFormConfigured,
  isShadeFormAllocatorEnabled,
  shadeFormTokenForTier,
} from '../services/inbound/shadeform-adapter.js'
import { provisionShadeFormRental } from '../services/inbound/shadeform-provision.js'
import {
  isHyperstackConfigured,
  isHyperstackAllocatorEnabled,
  hyperstackTokenForTier,
} from '../services/inbound/hyperstack-adapter.js'
import { provisionHyperstackRental } from '../services/inbound/hyperstack-provision.js'
import { probeAllProviders } from '../services/inbound/capacity-probe.js'

type ComputeRequestWithUser = ComputeRequest & { user: User }

const QUEUE_NAME = 'compute-allocator'
const TICK_INTERVAL_MS = parseInt(process.env.ALLOCATOR_TICK_MS ?? '10000', 10)

// How many candidate requests to evaluate per tick. Plenty of headroom
// for normal traffic; if backlog builds we'll see it in metrics and can
// raise this or shorten the tick interval.
const BATCH_SIZE = 25

// Heartbeat freshness threshold for "idle" nodes. Same value the admin
// auto-allocate route uses (apps/api/src/routes/admin-compute.ts:126)
// so manual and automatic paths see the same node pool.
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000

interface AllocatorDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
  io: SocketServer
}

export function createComputeAllocatorQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1, // retries handled by the next tick, not BullMQ
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  })
}

export function createComputeAllocatorWorker(deps: AllocatorDeps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      await runAllocatorTick(deps.prisma, deps.io)
    },
    {
      connection: deps.redis,
      concurrency: 1, // single-flight; we never want two ticks racing
    },
  )
}

export async function scheduleComputeAllocator(queue: Queue): Promise<void> {
  // Clear any prior repeatable so we don't accumulate them across deploys
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

// ---------------------------------------------------------------------------
// Core tick logic — exported for tests
// ---------------------------------------------------------------------------

export async function runAllocatorTick(prisma: PrismaClient, io: SocketServer): Promise<void> {
  const candidates = await prisma.computeRequest.findMany({
    where: {
      status: 'PENDING',
      txConfirmed: true,
    },
    orderBy: { requestedAt: 'asc' }, // FIFO so first paid = first served
    take: BATCH_SIZE,
    include: { user: true },
  })

  // Tick visibility. Without this, the only allocator log line ever
  // emitted is the initial "(10s tick)" startup banner — so a stuck
  // PENDING request looks identical to a healthy allocator with zero
  // work. We log a single line per tick describing what was picked up,
  // plus (when zero) a one-line diagnostic counting unconfirmed PENDING
  // rows so operators know immediately whether the issue is "nobody
  // paid yet" vs "allocator is broken".
  if (candidates.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[compute-allocator] tick: ${candidates.length} pending request(s)`)
  } else {
    const unconfirmed = await prisma.computeRequest.count({
      where: { status: 'PENDING', txConfirmed: false },
    })
    if (unconfirmed > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[compute-allocator] tick: 0 actionable, ${unconfirmed} PENDING request(s) waiting on txConfirmed=true`,
      )
    }
  }

  for (const cr of candidates) {
    try {
      await processRequest(prisma, io, cr)
    } catch (err) {
      // One bad row must not poison the batch. Log and continue.
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] failed on request ${cr.id}:`, err)
    }
  }
}

async function processRequest(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<void> {
  // Step 1: eligibility
  const verdict = await evaluateEligibility(prisma, cr, cr.user)

  if (!verdict.approved) {
    // Atomic transition to WAITLISTED with status guard.
    const result = await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        status: 'WAITLISTED',
        eligibilityFlags: verdict.flags,
        adminNote: verdict.reason,
      },
    })
    if (result.count > 0) {
      void createNotification(
        cr.userId,
        'COMPUTE_REQUEST_HELD',
        'Request Under Review',
        `Your ${cr.gpuCount}x ${cr.gpuTier} request is being reviewed by the team. You'll get an update shortly.`,
        `/buyer/requests/${cr.id}`,
      )
      io.emit('compute:waitlisted', {
        requestId: cr.id,
        userId: cr.userId,
        flags: verdict.flags,
        timestamp: new Date().toISOString(),
      })

      // 2026-06-11 third-round: when a hold fires that needs human
      // review (specifically HOLD_FIRST_RENTAL_NEEDS_ADMIN, the L3
      // verifiable backstop), ping admins. Redis dedupe (5-min
      // window, shared across all admins) so a burst of holds
      // becomes ONE email summarising the pending queue instead of
      // a per-row flood. Fires AFTER the buyer notification so a
      // Redis failure doesn't drop the buyer-facing message.
      const needsAdminReview = verdict.flags.some((f) =>
        f === 'HOLD_FIRST_RENTAL_NEEDS_ADMIN' ||
        f === 'HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS',
      )
      if (needsAdminReview) {
        void (async () => {
          try {
            const dedupeKey = 'admin-review-notify:lock'
            const lockTtlSec = 5 * 60
            const acquired = await REFUSAL_REDIS.set(
              dedupeKey,
              '1',
              'EX',
              lockTtlSec,
              'NX',
            )
            if (acquired !== 'OK') return // another tick already notified within the window

            const pending = await prisma.computeRequest.count({
              where: {
                status: 'WAITLISTED',
                eligibilityFlags: {
                  hasSome: [
                    'HOLD_FIRST_RENTAL_NEEDS_ADMIN',
                    'HOLD_UNVERIFIED_EMAIL_FIRST_RENTALS',
                  ],
                },
              },
            })
            const noun = pending === 1 ? 'request' : 'requests'
            const buyerEmail = cr.user.email ?? '(no email)'
            const totalUsd = cr.totalCost.toFixed(2)
            const title = `${pending} compute ${noun} need review`
            const body =
              `Latest: ${buyerEmail} requesting ${cr.gpuCount}× ${cr.gpuTier} ` +
              `for ${cr.durationDays} day${cr.durationDays === 1 ? '' : 's'} ` +
              `($${totalUsd}). Flags: ${verdict.flags.join(', ')}.`
            // Channels: admin User rows + ADMIN_NOTIFICATION_EMAILS env list.
            // The .local placeholder admin row gets the in-app + (undeliverable)
            // email; the env list reaches the real humans.
            await notifyAdmins(
              'ADMIN_REVIEW_REQUIRED',
              title,
              body,
              '/admin/compute',
            )
          } catch {
            // Notification failures must never block the buyer-
            // facing path. Admins will catch missed reviews via
            // the dashboard auto-refresh + sidebar badge.
          }
        })()
      }
    }
    return
  }

  // Step 2: pick idle nodes matching the tier
  //
  // M3: soft tiebreak chain when multiple nodes pass the hard filter:
  //   1. Higher operator reputationScore wins (NodeRunner relation)
  //      → PLATINUM (90+) operators picked over BRONZE (<60)
  //   2. Most recent heartbeat wins (existing M2 behavior)
  //
  // Implementation note: Prisma 5's orderBy only accepts the
  // {sort,nulls} form on direct scalar fields, not relation hops.
  // And Postgres's default NULLS FIRST for DESC would put nodes
  // without a NodeRunner at the top — exactly the wrong order.
  //
  // Workaround: fetch a wider candidate pool ordered by heartbeat
  // freshness (the cheap-to-index sort), then sort by reputation
  // in JS with explicit nulls-last handling, then slice to the
  // count we need. Pool size of max(gpuCount * 5, 20) gives enough
  // headroom that the top-N picks are still the truly best nodes.
  const PICK_POOL = Math.max(cr.gpuCount * 5, 20)
  // M4.4: hard-filter on region when the buyer specified one. Null
  // requiredRegion means "Any" (default) and the where clause skips
  // the predicate entirely. Region strings are free-form and matched
  // case-sensitively against Node.region (also a free-form String?
  // column).
  const requiredRegion = (cr as { requiredRegion?: string | null }).requiredRegion

  // C2 wave 2: belt-and-suspenders inference-only filter. The buyer-
  // compute zod refine already rejects consumer-tier + non-INFERENCE
  // combinations at the request boundary, but we re-apply the rule
  // here in case any future allocator extension substitutes tiers
  // (e.g. "request H200 but H100 works too"). Without this, such a
  // substitution could accidentally route a TRAINING request to a
  // consumer node.
  const workloadType = (cr as { workloadType?: 'INFERENCE' | 'TRAINING' | 'MIXED' }).workloadType ?? 'MIXED'
  // Note: not readonly — Prisma's enum filter expects a mutable array.
  const CONSUMER_TIER_LIST: GpuTier[] = ['CONSUMER', 'RTX_4090', 'RTX_3090']
  const consumerExclusion: { gpuTier?: { notIn: GpuTier[] } } = workloadType === 'INFERENCE'
    ? {}
    : { gpuTier: { notIn: CONSUMER_TIER_LIST } }

  // #7 operator-set pricing: fetch the tier's YieldFloor once so we can
  // compute each candidate's effective rate inline. Operators who set
  // a rate below the baseline win price tiebreaks; unpriced nodes fall
  // back to floor and tie with each other. OTHER tier (no YieldFloor)
  // returns null — those nodes sort on customRatePerHour alone, which
  // is the canonical price for that tier.
  const yieldFloor = await prisma.yieldFloor.findUnique({
    where: { gpuTier: cr.gpuTier },
    select: { ratePerHour: true },
  })
  const fallbackRatePerHour = yieldFloor?.ratePerHour ?? Number.POSITIVE_INFINITY

  // C2 wave 2 test exemption: seed nodes (id prefix test-c2-) have no
  // real agent and so cannot keep their own heartbeat fresh; exempting
  // them from the 2-minute freshness window lets the allocator continue
  // to pick them up for the duration of a test session. Same carve-out
  // already lives in public-listings.ts and the node-health monitor.
  const candidates = await prisma.node.findMany({
    where: {
      gpuTier: cr.gpuTier,
      status: 'ONLINE',
      currentJobId: null,
      assignedComputeRequestId: null,
      pendingDeletion: false,
      agentVersion: { not: null },
      OR: [
        { lastHeartbeat: { gte: new Date(Date.now() - HEARTBEAT_FRESH_MS) } },
        { id: { startsWith: 'test-c2-' } },
      ],
      ...(requiredRegion ? { region: requiredRegion } : {}),
      ...consumerExclusion,
    },
    orderBy: { lastHeartbeat: 'desc' },
    take: PICK_POOL,
    select: {
      id: true,
      walletAddress: true,
      lastHeartbeat: true,
      operatorRatePerHour: true,
      customRatePerHour: true,
      nodeRunner: { select: { id: true, reputationTier: true, reputationScore: true } },
    },
  })

  // M5.10c soft operator preference: if the buyer asked to rent from
  // a specific operator on the marketplace, the request carries
  // preferredOperatorId. We don't hard-filter (that would starve the
  // request when the preferred operator has no idle capacity); we
  // just push their nodes to the front of the sort.
  const preferredOperatorId = (cr as { preferredOperatorId?: string | null }).preferredOperatorId ?? null

  // M3 + M5.10c + #7 sort chain:
  //   1. preferredOperator match wins (buyer explicitly asked for them)
  //   2. reputation desc, nulls last (quality is the primary signal)
  //   3. effective rate asc (cheapest first — operators who priced
  //      below market win matches over same-reputation peers)
  //   4. most recent heartbeat
  const idleNodes = candidates
    .sort((a, b) => {
      // Tier-1: preferred operator wins.
      const aPref = preferredOperatorId && a.nodeRunner?.id === preferredOperatorId ? 1 : 0
      const bPref = preferredOperatorId && b.nodeRunner?.id === preferredOperatorId ? 1 : 0
      if (aPref !== bPref) return bPref - aPref
      // Tier-2: -Infinity for null score so it always sorts AFTER any real score
      const aScore = a.nodeRunner?.reputationScore ?? -Infinity
      const bScore = b.nodeRunner?.reputationScore ?? -Infinity
      if (aScore !== bScore) return bScore - aScore
      // Tier-3: cheapest effective rate wins. Unpriced nodes fall back
      // to the YieldFloor for the tier, so they tie with each other
      // and lose to anyone who priced under floor.
      const aRate = a.operatorRatePerHour ?? a.customRatePerHour ?? fallbackRatePerHour
      const bRate = b.operatorRatePerHour ?? b.customRatePerHour ?? fallbackRatePerHour
      if (aRate !== bRate) return aRate - bRate
      // Tier-4: most recent heartbeat
      return b.lastHeartbeat.getTime() - a.lastHeartbeat.getTime()
    })
    .slice(0, cr.gpuCount)

  if (idleNodes.length < cr.gpuCount) {
    // CAPACITY-FIRST CASCADE (2026-06-05 rework).
    //
    // The old version hardcoded the order Lambda -> RunPod -> Phala ->
    // io.net -> VoltageGPU. That punished buyers whenever a more
    // expensive provider happened to be tried first, AND it surfaced
    // an admin-action-required signal when nobody had stock.
    //
    // New behavior:
    //   1. probeAllProviders() runs each enabled provider's capacity
    //      check in parallel (3s timeout each so a slow one can't
    //      stall the tick).
    //   2. Providers WITH capacity are sorted by price ascending.
    //   3. We iterate in that order calling the matching tryXxxFallback
    //      until one wins. First success returns.
    //   4. If nobody had capacity, we leave the request in PENDING with
    //      a SEARCHING_CAPACITY flag (renamed from WAITING_ON_CAPACITY
    //      to communicate to admins + buyers that no manual action is
    //      required — the next tick re-probes 10s later).
    //
    // T7 confidential routing: when buyer asked for hardware-attested
    // TEE compute, the probe filter (preferConfidential=true) only
    // returns Phala + VoltageGPU candidates. Unattested providers
    // never enter the sorted list, protecting buyers (mostly early
    // testers + privacy-regulated workloads) from silent downgrade.
    const wantConfidential = (cr as { preferConfidential?: boolean }).preferConfidential === true

    const quotes = await probeAllProviders(cr.gpuTier, cr.gpuCount, {
      preferConfidential: wantConfidential,
    })

    if (quotes.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[compute-allocator] capacity probe for ${cr.id} (${cr.gpuCount}x ${cr.gpuTier}` +
        `${wantConfidential ? ', confidential' : ''}) -> ` +
        quotes.map((q) => `${q.provider}@$${q.pricePerHourUsd.toFixed(2)}/h`).join(' ; '),
      )
    }

    for (const quote of quotes) {
      let took = false
      switch (quote.provider) {
        case 'LAMBDA':
          took = await tryLambdaFallback(prisma, io, cr)
          break
        case 'RUNPOD':
          took = await tryRunPodFallback(prisma, io, cr)
          break
        case 'PHALA':
          took = await tryPhalaFallback(prisma, io, cr)
          break
        case 'IONET':
          took = await tryIoNetFallback(prisma, io, cr)
          break
        case 'VOLTAGEGPU':
          took = await tryVoltageGpuFallback(prisma, io, cr)
          break
        case 'VASTAI':
          took = await tryVastAiFallback(prisma, io, cr)
          break
        case 'TENSORDOCK':
          took = await tryTensorDockFallback(prisma, io, cr)
          break
        case 'SHADEFORM':
          took = await tryShadeFormFallback(prisma, io, cr)
          break
        case 'HYPERSTACK':
          took = await tryHyperstackFallback(prisma, io, cr)
          break
      }
      if (took) return
    }

    // Every probed provider either had no capacity or refused at
    // provision time. The request stays PENDING and the allocator
    // re-probes every 10s. Flag is informational only — admins do
    // NOT need to release anything.
    const capacityFlag = requiredRegion ? 'NO_REGION_CAPACITY' : 'SEARCHING_CAPACITY'
    await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        eligibilityFlags: [...verdict.flags, capacityFlag],
      },
    })
    return
  }

  // Step 3: allocate atomically
  const nodeIds = idleNodes.map(n => n.id)
  const headNodeId = nodeIds[0]
  if (!headNodeId) {
    // Shouldn't happen — we just checked length above — but the type
    // system needs the guard to narrow nodeIds[0] from `string | undefined`.
    return
  }
  const session = mintSshSession(cr.durationDays)
  // ratePerDay is the per-GPU daily rate. The full-rental per-minute rate
  // (what the meter multiplies minutesUsed against) is gpuCount-scaled so
  // accruedCost moves at the same rate as the upfront commitment burns
  // down — early-termination refund = totalCost - accruedCost stays clean.
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)

  // SSH connection details live on the Investment that provisioned each
  // node (Node model doesn't carry sshHost/sshPort itself). For a
  // single-node rental we just need the head node's host; for a cluster
  // we also need every other node's host so the WireGuard mesh planner
  // can build per-node endpoint entries.
  const investments = await prisma.investment.findMany({
    where: { nodeId: { in: nodeIds } },
    select: { nodeId: true, sshHost: true, sshPort: true, sshUsername: true },
  })
  const investmentByNode = new Map(investments.map(i => [i.nodeId, i]))
  const headInvestment = investmentByNode.get(headNodeId)

  // M4.7: when gpuCount > 1 we build a real cluster: a Cluster row, a
  // WireGuard mesh plan, and per-node rank + IP assignments inside
  // the atomic transaction below. Single-GPU rentals skip this entirely.
  const isCluster = cr.gpuCount > 1
  const clusterMesh = isCluster
    ? planClusterMesh(
        // The mesh plan uses the ComputeRequest id as a stable seed.
        // The Cluster row gets its own cuid below.
        cr.id,
        nodeIds.map(id => {
          const inv = investmentByNode.get(id)
          return {
            nodeId: id,
            publicHost: inv?.sshHost ?? `node-${id.slice(0, 8)}.unknown`,
          }
        }),
      )
    : null

  // M2 self-serve: the allocator transitions PENDING straight to ACTIVE
  // (skipping ALLOCATED) because everything the buyer needs is in place
  // at this point — node assigned, ephemeral SSH minted, rate computed.
  // The Phase 1 admin "review SSH details and click Activate" step was
  // a holdover from the data-center provisioning model where a human
  // confirmed the rack was up. With seeded ephemeral credentials it's
  // dead weight and breaks the sub-15s pay-to-prompt promise.
  //
  // Manual admin allocate routes (Manual Allocate + Activate from the
  // dashboard) still set status=ALLOCATED -> ACTIVE in two steps, so
  // the legacy flow is preserved for cases where an operator wants to
  // intervene.
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  // Use a transaction so node assignment and request transition land
  // together. If the request status guard fails (someone else won the
  // race), the node update is rolled back too. M4.7: when gpuCount > 1
  // we also create a Cluster row and stamp each Node with its rank +
  // WireGuard IP in the same transaction so the whole allocation is
  // truly atomic - any failure rolls back the cluster, all node
  // assignments, and the request transition.
  const allocated = await prisma.$transaction(async tx => {
    // Cluster creation goes first so we can reference its id below.
    let clusterId: string | null = null
    if (isCluster && clusterMesh) {
      const cluster = await tx.cluster.create({
        data: {
          status: 'PROVISIONING',
          wireguardSubnet: clusterMesh.subnet,
          masterNodeId: headNodeId,
        },
      })
      clusterId = cluster.id
    }

    const updated = await tx.computeRequest.updateMany({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        status: 'ACTIVE',
        approvedAt: cr.approvedAt ?? now,
        allocatedAt: now,
        activatedAt: now,
        expiresAt,
        allocatedNodeIds: nodeIds,
        allocationMethod: 'auto',
        eligibilityFlags: verdict.flags,
        ratePerMinute,
        sshSessionToken: session.token,
        sshSessionTokenExpiresAt: session.expiresAt,
        // SSH entrypoint: for a single-node rental this is the node's
        // public host. For a cluster, this is the master/head node's
        // host; workers are reached via ssh -J master worker-N over
        // the WireGuard mesh.
        sshHost: headInvestment?.sshHost ?? null,
        sshPort: headInvestment?.sshPort ?? 22,
        // Launch-blocker #2: per-rental Linux user the agent creates on
        // the operator's machine (was hardcoded 'a2e-buyer'). Format keeps
        // it under the 32-char useradd limit and human-greppable in
        // journalctl. sshSessionStatus stays at its default 'PENDING' so
        // the agent picks this up in its next heartbeat-response.
        sshUsername: `rental-${cr.id.slice(0, 12).toLowerCase()}`,
        clusterId,
      },
    })
    if (updated.count === 0) {
      // Lost the race; abort the transaction so nodes (and any cluster
      // we just created) stay free.
      throw new Error('AllocationRaceLost')
    }

    if (isCluster && clusterMesh && clusterId) {
      // M4.7: per-node cluster stamps. We do this one node at a time
      // because each row gets a distinct rank + ip; updateMany can't
      // express that in one call.
      for (const cfg of clusterMesh.nodes) {
        const taken = await tx.node.updateMany({
          where: { id: cfg.nodeId, assignedComputeRequestId: null },
          data: {
            assignedComputeRequestId: cr.id,
            clusterId,
            clusterRank: cfg.rank,
            clusterWireguardIp: cfg.ip,
          },
        })
        if (taken.count === 0) {
          // Someone else won this specific node in a race. Abort the
          // whole transaction so the partial cluster doesn't leak.
          throw new Error('AllocationRaceLost')
        }
      }
    } else {
      await tx.node.updateMany({
        where: { id: { in: nodeIds }, assignedComputeRequestId: null },
        data: { assignedComputeRequestId: cr.id },
      })
    }
    return true
  }).catch((err: Error) => {
    if (err.message === 'AllocationRaceLost') return false
    throw err
  })

  if (!allocated) return

  // M2: rental is now ACTIVE — buyer can SSH in, meter starts ticking
  // on the next 60s tick. Notification reflects "live" not just "allocated".
  void createNotification(
    cr.userId,
    'COMPUTE_ACTIVE',
    'Compute is Live',
    `Your ${cr.gpuCount}x ${cr.gpuTier} compute is ready. SSH details are in your dashboard.`,
    `/buyer/requests/${cr.id}`,
  )

  // Emit both events so existing dashboard subscribers (e.g. the toast for
  // 'compute:allocated' that already exists) keep working, and any new
  // subscribers can listen on the more accurate 'compute:active' name.
  const payload = {
    requestId: cr.id,
    userId: cr.userId,
    nodeIds,
    timestamp: now.toISOString(),
  }
  io.emit('compute:allocated', payload)
  io.emit('compute:active', payload)
}

// ---------------------------------------------------------------------------
// T5b: Lambda Labs fallback
// ---------------------------------------------------------------------------

/**
 * Try to provision a Lambda instance for the request when internal
 * supply is insufficient. Returns true when the request now belongs to
 * the lambda-poll worker (status flipped to PROVISIONING_EXTERNAL),
 * false when this allocator tick should continue to the legacy PENDING
 * + WAITING_ON_CAPACITY path.
 *
 * No-op (returns false) when:
 *   - Lambda is not configured (LAMBDA_API_KEY missing)
 *   - SSH key encryption is not configured
 *   - The tier isn't mapped (consumer tiers — Lambda doesn't sell)
 *   - The request needs more GPUs than one Lambda instance provides
 *     (multi-instance clusters land in a later milestone)
 *   - Lambda has no current capacity for the type / region
 *   - Lambda's API rejects the launch for any other reason
 *
 * On any failure mid-provision, the helper logs loudly but does not
 * throw so the surrounding allocator batch keeps processing other
 * requests.
 */
async function tryLambdaFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (!isLambdaConfigured()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (!lambdaTypeForTier(cr.gpuTier)) return false
  if (!fitsSingleLambdaInstance(cr.gpuTier, cr.gpuCount)) return false
  if (await isRefused(REFUSAL_REDIS, 'LAMBDA', cr.gpuTier)) return false

  // Mint a session token + compute the meter rate before the
  // provision call so we have everything ready for one atomic
  // ComputeRequest update on success. Lambda-provisioned rentals
  // surface SSH via ExternalRental (T5c) so the token here is only
  // used by buyer-facing endpoints that gate on "session live".
  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionLambdaRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] Lambda fallback failed for ${cr.id} (tier ${cr.gpuTier}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'LAMBDA', cr.gpuTier, (err as Error).message)
    return false
  }

  // Atomic transition: status guard prevents racing the manual
  // admin allocate path on the same request.
  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
      // allocatedNodeIds intentionally stays empty: Lambda is not in
      // our Node table. The link to provider state lives on
      // ExternalRental (queryable by computeRequestId, the unique).
    },
  })
  if (transitioned.count === 0) {
    // Lost the race with another path (e.g. admin manually allocated
    // between our supply check and now). Roll back the Lambda
    // provision so we don't leak billing.
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after Lambda provision; rolling back`,
    )
    // Late import keeps the allocator file dep graph stable when the
    // termination service grows.
    const { terminateLambdaRental } = await import('../services/inbound/lambda-provision.js')
    await terminateLambdaRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] Lambda fallback OK for ${cr.id}: provisioned ${provisionResult.providerInstanceType} in ${provisionResult.providerRegion} (externalRentalId=${provisionResult.externalRentalId})`,
  )

  // Notify the buyer that their rental is provisioning externally.
  // The lambda-poll worker fires the COMPUTE_ACTIVE notification
  // once Lambda reports the instance is booted.
  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared on Lambda Labs (${provisionResult.providerRegion}). SSH credentials appear in your dashboard within ~60s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'LAMBDA',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * T5e — RunPod inbound supply fallback (2nd after Lambda).
 *
 * Same semantics as tryLambdaFallback: success returns true and the
 * caller skips the rest of the allocator tick for this request;
 * failure logs and returns false so the caller continues to the next
 * fallback or the legacy WAITING_ON_CAPACITY path.
 *
 * No-op when:
 *   - RUNPOD_API_KEY not set
 *   - SSH key encryption not configured
 *   - Tier not mapped on RunPod (B300 etc.)
 *   - Request exceeds per-pod GPU max (>8 for most SKUs)
 *   - RunPod returns 500 "no instances available" (real-world capacity
 *     scarcity — community + datacenter both volatile for H100/H200/
 *     B200). The provision call surfaces this as a typed error which
 *     we catch + log + return false so the next allocator tick can
 *     retry or another provider can take it.
 *
 * Tier cascade: COMMUNITY (cheapest) is tried by default. SECURE tier
 * fallback within RunPod is a deliberate non-feature for MVP — the
 * allocator tick will retry next pass, and capacity comes back fast
 * on community. If community is consistently empty for a specific
 * SKU class, we can add a per-tier secure escalation later.
 */
async function tryRunPodFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (!isRunPodConfigured()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (!runPodTypeForTier(cr.gpuTier)) return false
  if (await isRefused(REFUSAL_REDIS, 'RUNPOD', cr.gpuTier)) return false
  if (!fitsSingleRunPodPod(cr.gpuTier, cr.gpuCount)) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  // Tier selection:
  //   preferDedicatedTier=true  -> SECURE only (skip COMMUNITY
  //     entirely). Buyer flagged the workload as variance-sensitive
  //     (benchmarks, reproducible inference measurements). COMMUNITY
  //     hosts may run other tenants on the same physical machine
  //     which introduces noise that distorts benchmark results.
  //   preferDedicatedTier=false -> COMMUNITY first (cheapest), then
  //     SECURE if community returns "no instances available". Most
  //     rentals don't need dedicated hosts and benefit from the 5-7x
  //     cheaper community pricing for H100/H200.
  let provisionResult
  const initialTier: 'COMMUNITY' | 'SECURE' = cr.preferDedicatedTier ? 'SECURE' : 'COMMUNITY'
  try {
    provisionResult = await provisionRunPodRental(prisma, cr.id, { cloudType: initialTier })
  } catch (err) {
    const message = (err as Error).message
    // Match every error string that means "RunPod is out of stock for
    // this SKU right now" — both the upstream wording ("no instances
    // currently available", from createPod rejection) AND the wording
    // our own provisionRunPodRental throws ("no current capacity",
    // when listGpuTypes reports hasCurrentStock=false). The old regex
    // only caught the first, so the COMMUNITY-empty -> SECURE
    // escalation never fired for the second case, even though that
    // case is what the local stock-check throws on the most-common
    // empty-community path.
    const isCapacityShort = /no (instances currently available|current capacity)/i.test(message)
    if (!isCapacityShort) {
      // eslint-disable-next-line no-console
      console.error(
        `[compute-allocator] RunPod fallback failed for ${cr.id} (tier ${cr.gpuTier}, ${initialTier}):`,
        message,
      )
      void recordRefusal(REFUSAL_REDIS, 'RUNPOD', cr.gpuTier, message)
      return false
    }

    // For preferDedicatedTier rentals there's no fallback — SECURE
    // is the only acceptable tier so capacity shortage means we wait
    // for the next allocator tick rather than satisfy with COMMUNITY.
    if (cr.preferDedicatedTier) {
      // eslint-disable-next-line no-console
      console.log(
        `[compute-allocator] RunPod SECURE empty for dedicated-tier ${cr.id}; no community fallback (preferDedicatedTier=true)`,
      )
      return false
    }

    // Standard escalation: COMMUNITY empty -> SECURE same tick.
    // Buyer-facing ratePerMinute stays at the buyer's quote -- the
    // platform absorbs the secure-tier premium for this rental. Net
    // result: better availability UX, slightly thinner margin on
    // rentals that escalate. Track as a metric for pricing decisions.
    try {
      provisionResult = await provisionRunPodRental(prisma, cr.id, { cloudType: 'SECURE' })
      // eslint-disable-next-line no-console
      console.log(
        `[compute-allocator] RunPod fallback ESCALATED to SECURE for ${cr.id} (community was empty)`,
      )
    } catch (escErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[compute-allocator] RunPod fallback failed for ${cr.id} on both COMMUNITY and SECURE:`,
        (escErr as Error).message,
      )
      void recordRefusal(REFUSAL_REDIS, 'RUNPOD', cr.gpuTier, (escErr as Error).message)
      return false
    }
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // Lost race with another path (admin manual allocate, etc.).
    // Roll back the RunPod provision so we don't leak billing.
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after RunPod provision; rolling back`,
    )
    const { terminateRunPodRental } = await import('../services/inbound/runpod-provision.js')
    await terminateRunPodRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] RunPod rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] RunPod fallback OK for ${cr.id}: provisioned ${provisionResult.providerInstanceType} (externalRentalId=${provisionResult.externalRentalId})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared on RunPod. SSH credentials appear in your dashboard within ~60s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'RUNPOD',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * T5f — try Phala as the 3rd-tier overflow supplier for confidential
 * GPU rentals (Intel TDX + AMD SEV-SNP).
 *
 * Same semantics as tryRunPodFallback: success returns true and the
 * caller skips the rest of the allocator tick; failure logs and
 * returns false so the caller falls through to WAITING_ON_CAPACITY.
 *
 * Gated by env PHALA_ALLOCATOR_ENABLED=true. Default OFF until the
 * createCvm body schema has been verified end-to-end via
 * phala-provision:test (the body shape in phala-adapter.ts is
 * best-guess; first real call returns a 422 with required field
 * names that we then bake into the adapter). Once verified, set
 * PHALA_ALLOCATOR_ENABLED=true in Render env to activate the cascade.
 *
 * No-op when:
 *   - PHALA_ALLOCATOR_ENABLED is not exactly "true"
 *   - PHALA_API_KEY not set
 *   - SSH key encryption not configured
 *   - Tier not mapped on Phala (currently H100/B200/L40S all no-op
 *     because Phala only carries H200)
 *   - Request needs a GPU count that doesn't match a Phala SKU
 *     (only 1x and 8x H200 currently)
 *
 * Phala has no community/secure tier split (every CVM is dedicated
 * by construction; confidential VMs can't be multi-tenanted), so
 * there's no escalation logic — provision succeeds or doesn't.
 */
async function tryPhalaFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (process.env.PHALA_ALLOCATOR_ENABLED !== 'true') return false
  if (!isPhalaConfigured()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (!phalaTypeForTier(cr.gpuTier, cr.gpuCount)) return false
  if (!fitsSinglePhalaCvm(cr.gpuTier, cr.gpuCount)) return false
  if (await isRefused(REFUSAL_REDIS, 'PHALA', cr.gpuTier)) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionPhalaRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] Phala fallback failed for ${cr.id} (tier ${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'PHALA', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // Lost race; roll back Phala provision so we don't leak billing.
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after Phala provision; rolling back`,
    )
    const { terminatePhalaRental } = await import('../services/inbound/phala-provision.js')
    await terminatePhalaRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] Phala rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] Phala fallback OK for ${cr.id}: provisioned ${provisionResult.providerInstanceType} (externalRentalId=${provisionResult.externalRentalId})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} confidential rental is being prepared. SSH credentials appear in your dashboard within ~90-180s (TEE attestation adds boot time).`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'PHALA',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * T5g — try io.net VMaaS as the 4th-tier overflow supplier.
 *
 * Same shape as tryRunPodFallback. io.net is currently a standard
 * (non-confidential) overflow supplier; its confidential SKUs are
 * email-gated and not used by this fallback. When/if confidential
 * SKUs surface in the catalog after allow-list, ionet-tier-mapping.ts
 * gets updated and this hook routes them too.
 *
 * Gated by env IONET_ALLOCATOR_ENABLED=true. Default OFF until tier
 * mapping is populated with real hardware_ids (run ionet:inspect to
 * see the catalog, populate the MAPPING constant, then flip the env).
 *
 * No-op when:
 *   - IONET_ALLOCATOR_ENABLED is not exactly "true"
 *   - IONET_API_KEY not set
 *   - SSH key encryption not configured
 *   - Tier not mapped on io.net (mapping has no entry)
 *   - Request needs more GPUs than the SKU's maxGpusPerVm
 */
async function tryIoNetFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (process.env.IONET_ALLOCATOR_ENABLED !== 'true') return false
  if (!isIoNetConfigured()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (await isRefused(REFUSAL_REDIS, 'IONET', cr.gpuTier)) return false
  if (!ioNetTypeForTier(cr.gpuTier, cr.gpuCount)) return false
  if (!fitsSingleIoNetVm(cr.gpuTier, cr.gpuCount)) return false
  // T7 — when buyer asked for confidential, only route to io.net IF
  // the business@io.net allow-list email has completed AND we've
  // flipped IONET_CONFIDENTIAL_ENABLED=true. Without that gate,
  // io.net's catalog only exposes standard (non-TEE) SKUs, so
  // routing a confidential request here would silently produce
  // non-attested hardware. Allocator falls through to VoltageGPU.
  const wantConfidential = (cr as { preferConfidential?: boolean }).preferConfidential === true
  if (wantConfidential && process.env.IONET_CONFIDENTIAL_ENABLED !== 'true') {
    return false
  }

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionIoNetRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] io.net fallback failed for ${cr.id} (tier ${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'IONET', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after io.net provision; rolling back`,
    )
    const { terminateIoNetRental } = await import('../services/inbound/ionet-provision.js')
    await terminateIoNetRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] io.net rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] io.net fallback OK for ${cr.id}: provisioned hardware_id=${provisionResult.providerInstanceType} (externalRentalId=${provisionResult.externalRentalId})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared. SSH credentials appear in your dashboard within ~60-90s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'IONET',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * T5h — try VoltageGPU as 5th-tier overflow supplier (confidential
 * GPU). Cheapest H100 CC mode in the market today ($2.77/h vs
 * Azure's $8.90/h). Confidential-only — non-confidential workloads
 * route to standard suppliers above.
 *
 * Gated by env VOLTAGEGPU_ALLOCATOR_ENABLED=true. Default OFF until
 * tier mapping is verified against the live catalog. Adapter body
 * shapes are BEST-GUESS (docs.voltagegpu.com wasn't reachable from
 * the research sandbox) so expect some empirical iteration on first
 * provision attempts.
 *
 * No-op when:
 *   - VOLTAGEGPU_ALLOCATOR_ENABLED is not exactly "true"
 *   - VOLTAGEGPU_API_KEY not set
 *   - SSH key encryption not configured
 *   - Tier+count not mapped (skeleton currently has H100/H200/B200 x1 only)
 */
async function tryVoltageGpuFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (process.env.VOLTAGEGPU_ALLOCATOR_ENABLED !== 'true') return false
  if (!isVoltageGpuConfigured()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (await isRefused(REFUSAL_REDIS, 'VOLTAGEGPU', cr.gpuTier)) return false
  if (!voltageGpuTypeForTier(cr.gpuTier, cr.gpuCount)) return false
  if (!fitsSingleVoltageGpuPod(cr.gpuTier, cr.gpuCount)) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionVoltageGpuRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] VoltageGPU fallback failed for ${cr.id} (${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'VOLTAGEGPU', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after VoltageGPU provision; rolling back`,
    )
    const { terminateVoltageGpuRental } = await import('../services/inbound/voltagegpu-provision.js')
    await terminateVoltageGpuRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] VoltageGPU rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] VoltageGPU fallback OK for ${cr.id}: ${provisionResult.providerInstanceType} (externalRentalId=${provisionResult.externalRentalId})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} confidential rental is being prepared. SSH credentials appear in your dashboard within ~60s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'VOLTAGE_GPU',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * Vast.ai sixth-supplier fallback. Peer-to-peer GPU marketplace with
 * dramatically larger inventory of consumer cards (RTX 4090 / 3090)
 * than RunPod COMMUNITY, plus a healthy secondary supply of L40S and
 * H100. Verified-host filter at probe time + provision time ensures we
 * only book reliable hosts (reliability >= 0.95).
 *
 * Same shape as the other tryXxxFallback functions: returns true on
 * successful provision (request transitions to PROVISIONING_EXTERNAL);
 * returns false on any pre-condition fail, mapping miss, or upstream
 * error so the cascade continues.
 *
 * Two gates beyond the standard configured-check ensure rollout
 * control:
 *   1. VASTAI_API_KEY must be set on the server (isVastAiConfigured)
 *   2. VASTAI_ALLOCATOR_ENABLED=true must be explicitly opted-in
 *      (isVastAiAllocatorEnabled). Without this, even a fully-keyed
 *      deployment skips Vast.ai entirely.
 *
 * The probe-side guard (capacity-probe.ts) also short-circuits the
 * Vast.ai candidate when the allocator-enabled flag is off — so this
 * function should never be called with the flag false; the
 * defense-in-depth check below is just belt-and-suspenders.
 */
async function tryVastAiFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (!isVastAiConfigured()) return false
  if (!isVastAiAllocatorEnabled()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (!vastAiTypeForTier(cr.gpuTier, cr.gpuCount)) return false
  if (!fitsSingleVastAiHost(cr.gpuTier, cr.gpuCount)) return false
  if (await isRefused(REFUSAL_REDIS, 'VASTAI', cr.gpuTier)) return false
  // Confidential routing: Vast.ai's verified-host network is NOT
  // TEE/SEV-SNP attested. preferConfidential requests must skip
  // Vast.ai entirely; they continue to Phala / VoltageGPU.
  const wantConfidential = (cr as { preferConfidential?: boolean }).preferConfidential === true
  if (wantConfidential) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionVastAiRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] Vast.ai fallback failed for ${cr.id} (tier ${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'VASTAI', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after Vast.ai provision; rolling back`,
    )
    const { terminateVastAiRental } = await import('../services/inbound/vastai-provision.js')
    await terminateVastAiRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] Vast.ai rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] Vast.ai fallback OK for ${cr.id}: provisioned gpu=${provisionResult.providerInstanceType} ` +
    `(externalRentalId=${provisionResult.externalRentalId}, region=${provisionResult.providerRegion})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared. SSH credentials appear in your dashboard within ~60-90s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'VASTAI',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * TensorDock seventh-supplier fallback. Peer-to-peer marketplace; one
 * direct adapter alongside Vast.ai with different host pool and
 * pricing dynamics. Particularly strong on prosumer cards (RTX A4000
 * from $0.07/h, RTX 3090 from $0.20/h) and the occasional A100 at
 * $1.25/h that beats every other direct provider.
 *
 * Same shape as tryVastAiFallback: returns true when the cascade has
 * taken the request, false on any pre-condition fail. Confidential
 * requests must skip TensorDock (no TEE attestation in the host pool).
 *
 * Gates:
 *   1. TENSORDOCK_API_KEY + TENSORDOCK_API_TOKEN set (isTensorDockConfigured)
 *   2. TENSORDOCK_ALLOCATOR_ENABLED defaults true (master-switch).
 *      Flip false for surgical bypass.
 */
async function tryTensorDockFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (!isTensorDockConfigured()) return false
  if (!isTensorDockAllocatorEnabled()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (!tensorDockTypeForTier(cr.gpuTier)) return false
  if (!fitsSingleTensorDockHost(cr.gpuTier, cr.gpuCount)) return false
  if (await isRefused(REFUSAL_REDIS, 'TENSORDOCK', cr.gpuTier)) return false
  const wantConfidential = (cr as { preferConfidential?: boolean }).preferConfidential === true
  if (wantConfidential) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionTensorDockRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] TensorDock fallback failed for ${cr.id} (tier ${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'TENSORDOCK', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after TensorDock provision; rolling back`,
    )
    const { terminateTensorDockRental } = await import('../services/inbound/tensordock-provision.js')
    await terminateTensorDockRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] TensorDock rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] TensorDock fallback OK for ${cr.id}: provisioned gpu=${provisionResult.providerInstanceType} ` +
    `(externalRentalId=${provisionResult.externalRentalId}, region=${provisionResult.providerRegion})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared. SSH credentials appear in your dashboard within ~60-90s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'TENSORDOCK',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * Shadeform eighth-supplier fallback. Aggregator over ~18 underlying
 * clouds (Crusoe, Lambda, Hyperstack, Latitude, Verda, Massedcompute,
 * Nebius, Vultr, Paperspace, Scaleway, etc.) at prices that often beat
 * direct providers. Plug-once, get all underlying networks.
 *
 * Gates:
 *   1. SHADEFORM_API_KEY set (isShadeFormConfigured)
 *   2. SHADEFORM_ALLOCATOR_ENABLED defaults true
 *   3. tier mapped (Shadeform's GPU type tokens)
 *
 * Confidential routes never fall through to Shadeform: aggregator
 * clouds aren't attested. preferConfidential stays on direct
 * Phala / VoltageGPU paths.
 */
async function tryShadeFormFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (!isShadeFormConfigured()) return false
  if (!isShadeFormAllocatorEnabled()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (!shadeFormTokenForTier(cr.gpuTier)) return false
  if (await isRefused(REFUSAL_REDIS, 'SHADEFORM', cr.gpuTier)) return false
  const wantConfidential = (cr as { preferConfidential?: boolean }).preferConfidential === true
  if (wantConfidential) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionShadeFormRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] Shadeform fallback failed for ${cr.id} (tier ${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'SHADEFORM', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after Shadeform provision; rolling back`,
    )
    const { terminateShadeFormRental } = await import('../services/inbound/shadeform-provision.js')
    await terminateShadeFormRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[compute-allocator] Shadeform rollback failed for ${provisionResult.externalRentalId}:`, err)
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] Shadeform fallback OK for ${cr.id}: provisioned gpu=${provisionResult.providerInstanceType} ` +
    `(externalRentalId=${provisionResult.externalRentalId}, region=${provisionResult.providerRegion})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared. SSH credentials appear in your dashboard within ~60-90s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'SHADEFORM',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}

/**
 * Hyperstack direct fallback. Goes straight to NexGen Cloud's REST,
 * skipping the Shadeform markup. Same supply pool we just verified
 * end-to-end on 2026-06-08 (cmq5if3gr000 A100, cmq5j7msf000 H100 both
 * succeeded via Shadeform routing to Hyperstack); direct is just
 * cheaper.
 *
 * Gates:
 *   1. HYPERSTACK_API_KEY set (isHyperstackConfigured)
 *   2. HYPERSTACK_ALLOCATOR_ENABLED defaults true
 *   3. tier mapped (Hyperstack GPU type tokens)
 *
 * Confidential routes never fall through to Hyperstack: NexGen Cloud's
 * VMs aren't attested. preferConfidential stays on direct Phala /
 * VoltageGPU paths.
 */
async function tryHyperstackFallback(
  prisma: PrismaClient,
  io: SocketServer,
  cr: ComputeRequestWithUser,
): Promise<boolean> {
  if (!isHyperstackConfigured()) return false
  if (!isHyperstackAllocatorEnabled()) return false
  if (!isKeyEncryptionConfigured()) return false
  if (await isRefused(REFUSAL_REDIS, 'HYPERSTACK', cr.gpuTier)) return false
  if (!hyperstackTokenForTier(cr.gpuTier)) return false
  const wantConfidential = (cr as { preferConfidential?: boolean }).preferConfidential === true
  if (wantConfidential) return false

  const session = mintSshSession(cr.durationDays)
  const ratePerMinute = (cr.ratePerDay * cr.gpuCount) / (24 * 60)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + cr.durationDays * 86400000)

  let provisionResult
  try {
    provisionResult = await provisionHyperstackRental(prisma, cr.id)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[compute-allocator] Hyperstack fallback failed for ${cr.id} (tier ${cr.gpuTier} x${cr.gpuCount}):`,
      (err as Error).message,
    )
    void recordRefusal(REFUSAL_REDIS, 'HYPERSTACK', cr.gpuTier, (err as Error).message)
    return false
  }

  const transitioned = await prisma.computeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: {
      status: 'PROVISIONING_EXTERNAL',
      ratePerMinute,
      expiresAt,
      sshSessionToken: session.token,
      sshSessionTokenExpiresAt: session.expiresAt,
      sshSessionStatus: 'PROVISIONING',
    },
  })
  if (transitioned.count === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[compute-allocator] race on ${cr.id} after Hyperstack provision; rolling back`,
    )
    const { terminateHyperstackRental } = await import('../services/inbound/hyperstack-provision.js')
    await terminateHyperstackRental(
      prisma,
      provisionResult.externalRentalId,
      'allocator race: another path won the request',
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[compute-allocator] Hyperstack rollback failed for ${provisionResult.externalRentalId}:`,
        err,
      )
    })
    return false
  }

  // eslint-disable-next-line no-console
  console.log(
    `[compute-allocator] Hyperstack fallback OK for ${cr.id}: provisioned flavor=${provisionResult.providerInstanceType} ` +
    `(externalRentalId=${provisionResult.externalRentalId}, region=${provisionResult.providerRegion})`,
  )

  void createNotification(
    cr.userId,
    'COMPUTE_REQUEST_APPROVED',
    'Compute is Provisioning',
    `Your ${cr.gpuCount}x ${cr.gpuTier} rental is being prepared. SSH credentials appear in your dashboard within ~60-90s.`,
    `/buyer/requests/${cr.id}`,
  )

  io.emit('compute:provisioning-external', {
    requestId: cr.id,
    userId: cr.userId,
    provider: 'HYPERSTACK',
    instanceType: provisionResult.providerInstanceType,
    region: provisionResult.providerRegion,
    timestamp: now.toISOString(),
  })

  return true
}
