/**
 * PROVISIONING_EXTERNAL soft-reroute worker with multi-provider fallback ladder.
 *
 * Sits BEFORE the existing 20-minute hard-cancel timeout
 * (provisioning-timeout.ts). When an external rental hasn't reached
 * ACTIVE within SOFT_THRESHOLD_MS since createdAt, we:
 *
 *   1. Terminate the stuck rental on the original provider's side
 *      (e.g. delete the Vast.ai instance so we stop being billed)
 *   2. DELETE the local ExternalRental row so that downstream provider
 *      provision functions don't hit the (computeRequestId) unique
 *      constraint or their own idempotency checks
 *   3. Try the fallback ladder in order: Shadeform -> RunPod -> Lambda
 *      Each provider's provisionXxxRental() is called inside try/catch.
 *      On success, ladder exits. On failure, delete the (possibly empty)
 *      row and move to next.
 *   4. If all fallback providers refuse, leave the ComputeRequest in
 *      PROVISIONING_EXTERNAL with a stamped adminNote. The existing
 *      20-min hard-timeout worker takes over and refunds the buyer.
 *
 * Ladder order rationale:
 *   - Shadeform first: aggregates many underlying clouds (Hyperstack,
 *     Latitude, MassedCompute, Crusoe, etc.) behind one API, so it has
 *     the broadest supply
 *   - RunPod second: large independent pool, fast provisioning when
 *     supply exists, separate inventory from Vast.ai
 *   - Lambda third: reliable but limited GPU variety; last resort
 *
 * adminNote-based idempotency: each ladder attempt stamps the marker
 *   `[reroute-fired] from <ORIGINAL> -> attempted:<P1>+<P2>+...`
 * Once stamped, subsequent ticks skip this CR entirely. Fires AT MOST
 * ONCE per ComputeRequest regardless of how many providers we tried.
 *
 * Configurability:
 *   PROVISIONING_REROUTE_ENABLED        default 'true'
 *   PROVISIONING_REROUTE_SOFT_MS        default 480_000  (8 min)
 *   PROVISIONING_REROUTE_TICK_MS        default 60_000   (60s)
 *
 * Disable in prod via env when investigating provider issues without
 * the worker reshuffling state under you.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { provisionShadeFormRental } from '../services/inbound/shadeform-provision.js'
import { provisionRunPodRental } from '../services/inbound/runpod-provision.js'
import { provisionLambdaRental } from '../services/inbound/lambda-provision.js'
import { isShadeFormConfigured } from '../services/inbound/shadeform-adapter.js'
import { isRunPodConfigured } from '../services/inbound/runpod-adapter.js'
import { isLambdaConfigured } from '../services/inbound/lambda-adapter.js'
import {
  terminateExternalRentalForRequest,
  UnknownProviderError,
} from '../services/inbound/terminate-dispatcher.js'

const QUEUE_NAME = 'provisioning-reroute'
const TICK_INTERVAL_MS = parseInt(
  process.env.PROVISIONING_REROUTE_TICK_MS ?? '60000',
  10,
)
const SOFT_THRESHOLD_MS = parseInt(
  process.env.PROVISIONING_REROUTE_SOFT_MS ?? `${8 * 60 * 1000}`,
  10,
)
const BATCH_SIZE = 20

// Sentinel string we prepend to ComputeRequest.adminNote to mark that
// this request has already been rerouted once. The check is a simple
// includes() on the column.
const REROUTE_MARKER = '[reroute-fired]'

// Providers we route AWAY from. The fallback ladder targets a disjoint
// set (Shadeform, RunPod, Lambda) — we'd never reroute Shadeform to
// Shadeform. Reroute-source providers map to "anywhere except where
// you came from"; reroute-target providers map to "the ladder below."
const REROUTABLE_SOURCE_PROVIDERS = new Set([
  'VASTAI',
  'IONET',
  'PHALA',
  'VOLTAGEGPU',
  'HYPERSTACK',
  // RUNPOD and LAMBDA are reroute-targets but ALSO sources, so we
  // include them. If a buyer's request initially routed to RunPod and
  // got stuck, we still want to try Shadeform / Lambda from there.
  'RUNPOD',
  'LAMBDA',
])

// One ladder rung: a provision function + a configured-guard + a name
// for logging and adminNote stamping. Order in this array is the
// fallback order.
interface LadderRung {
  provider: 'SHADEFORM' | 'RUNPOD' | 'LAMBDA'
  isConfigured: () => boolean
  provision: (
    prisma: PrismaClient,
    computeRequestId: string,
  ) => Promise<unknown>
}

const FALLBACK_LADDER: LadderRung[] = [
  {
    provider: 'SHADEFORM',
    isConfigured: isShadeFormConfigured,
    provision: provisionShadeFormRental,
  },
  {
    provider: 'RUNPOD',
    isConfigured: isRunPodConfigured,
    provision: provisionRunPodRental,
  },
  {
    provider: 'LAMBDA',
    isConfigured: isLambdaConfigured,
    provision: provisionLambdaRental,
  },
]

interface Deps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createProvisioningRerouteQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    },
  })
}

export function createProvisioningRerouteWorker(deps: Deps): Worker {
  return new Worker(
    QUEUE_NAME,
    async () => {
      if (process.env.PROVISIONING_REROUTE_ENABLED === 'false') return
      await runProvisioningRerouteTick(deps.prisma)
    },
    {
      connection: deps.redis,
      concurrency: 1,
    },
  )
}

export async function scheduleProvisioningReroute(queue: Queue): Promise<void> {
  const existing = await queue.getRepeatableJobs()
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key)
  }
  await queue.add('tick', {}, { repeat: { every: TICK_INTERVAL_MS } })
}

export async function runProvisioningRerouteTick(
  prisma: PrismaClient,
): Promise<void> {
  const cutoff = new Date(Date.now() - SOFT_THRESHOLD_MS)

  // Find ExternalRental rows that have been in PENDING status for
  // longer than SOFT_THRESHOLD_MS since CREATION on a routable
  // provider. createdAt is immutable, so this signal is robust against
  // provider-poll-worker chatter that would otherwise keep updatedAt
  // fresh on a stalled rental.
  const stuckRentals = await prisma.externalRental.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lte: cutoff },
      provider: { in: Array.from(REROUTABLE_SOURCE_PROVIDERS) },
    },
    take: BATCH_SIZE,
    select: {
      id: true,
      provider: true,
      computeRequestId: true,
    },
  })

  if (stuckRentals.length === 0) return

  for (const er of stuckRentals) {
    try {
      await rerouteOne(prisma, er)
    } catch (err) {
      console.error(
        `[provisioning-reroute] failed on rental ${er.id} (${er.provider}):`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

async function rerouteOne(
  prisma: PrismaClient,
  er: { id: string; provider: string; computeRequestId: string },
): Promise<void> {
  const cr = await prisma.computeRequest.findUnique({
    where: { id: er.computeRequestId },
    select: {
      id: true,
      status: true,
      adminNote: true,
      gpuTier: true,
      gpuCount: true,
    },
  })
  if (!cr) return
  if (cr.status !== 'PROVISIONING_EXTERNAL') return
  if (cr.adminNote?.includes(REROUTE_MARKER)) return

  console.log(
    `[provisioning-reroute] starting ladder for ${cr.id} from ${er.provider} ` +
      `(${cr.gpuCount}x ${cr.gpuTier}, stuck > ${Math.round(SOFT_THRESHOLD_MS / 60000)}min)`,
  )

  // Step 1: terminate the stuck rental on the source provider so we
  // stop paying for it. Best-effort.
  try {
    await terminateExternalRentalForRequest(
      prisma,
      cr.id,
      `Soft reroute: ${er.provider} took > ${Math.round(SOFT_THRESHOLD_MS / 60000)}min without progress`,
    )
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      console.error(
        `[provisioning-reroute] unknown-provider terminate for ${cr.id}: ${err.message}; continuing`,
      )
    } else {
      console.error(
        `[provisioning-reroute] terminate-on-source failed for ${cr.id}; continuing:`,
        err,
      )
    }
  }

  // Step 2: delete the source ExternalRental row entirely. The
  // (computeRequestId) unique constraint AND the provision functions'
  // own idempotency checks would both block a fresh provider attempt
  // if we just marked the row CLOSED. Deletion is safe because
  // terminate-dispatcher already destroyed the upstream instance and
  // we don't need the row's history for buyer-facing accounting
  // (ComputeRequest carries the canonical buyer record).
  await prisma.externalRental.deleteMany({
    where: { id: er.id },
  })

  // Step 3: walk the fallback ladder. Each rung gets the same shot:
  // CR flipped to PENDING (provisionXxxRental's status guard), call
  // the provider's provision function, on throw delete any phantom
  // row and move on. On success, the function leaves the ComputeRequest
  // back in PROVISIONING_EXTERNAL with a fresh ExternalRental — we're
  // done.
  const attemptedProviders: string[] = []
  let succeededWith: string | null = null

  for (const rung of FALLBACK_LADDER) {
    if (rung.provider === er.provider) {
      // Don't reroute a provider to itself, even if it's also in
      // the fallback list (e.g. RunPod stuck rerouted via Shadeform
      // and Lambda, NOT RunPod again).
      continue
    }
    if (!rung.isConfigured()) {
      continue
    }

    // Flip CR back to PENDING for the provision function's status
    // guard. We always do this — provisionXxxRental expects PENDING.
    await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: { in: ['PROVISIONING_EXTERNAL', 'PENDING'] } },
      data: { status: 'PENDING' },
    })

    try {
      await rung.provision(prisma, cr.id)
      succeededWith = rung.provider
      attemptedProviders.push(rung.provider)
      console.log(
        `[provisioning-reroute] ${cr.id} successfully rerouted to ${rung.provider}`,
      )
      break
    } catch (err) {
      attemptedProviders.push(rung.provider)
      const msg = err instanceof Error ? err.message : String(err)
      console.log(
        `[provisioning-reroute] ${rung.provider} refused ${cr.id}: ${msg}`,
      )
      // Clear any partial ExternalRental row the provider might have
      // created before throwing, so the next rung's idempotency check
      // sees a clean slate.
      await prisma.externalRental.deleteMany({
        where: { computeRequestId: cr.id },
      })
    }
  }

  // Step 4: write the adminNote marker AFTER the ladder so we capture
  // every provider we attempted. If we succeeded, the new provision
  // function has already flipped CR back to PROVISIONING_EXTERNAL and
  // we only need to stamp the note. If we failed everywhere, restore
  // PROVISIONING_EXTERNAL so the hard-timeout worker can do its job.
  const stampSuffix = succeededWith
    ? `succeeded:${succeededWith}`
    : 'all-ladder-rungs-refused, falling through to hard-timeout'
  const rerouteNote =
    `${REROUTE_MARKER} from ${er.provider} -> ` +
    `attempted:${attemptedProviders.join('+') || 'none'}; ${stampSuffix} at ${new Date().toISOString()}`
  const previousNote = cr.adminNote ?? ''
  const newNote = previousNote ? `${previousNote}; ${rerouteNote}` : rerouteNote

  if (succeededWith) {
    // Provision function already set us to PROVISIONING_EXTERNAL; just
    // stamp the note.
    await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: 'PROVISIONING_EXTERNAL' },
      data: { adminNote: newNote },
    })
  } else {
    // Ladder exhausted. Put CR back into PROVISIONING_EXTERNAL even
    // though there's no live ExternalRental — that triggers the
    // hard-timeout worker on its next tick to cancel + refund.
    await prisma.computeRequest.updateMany({
      where: { id: cr.id, status: { in: ['PENDING', 'PROVISIONING_EXTERNAL'] } },
      data: {
        status: 'PROVISIONING_EXTERNAL',
        adminNote: newNote,
      },
    })
  }
}
