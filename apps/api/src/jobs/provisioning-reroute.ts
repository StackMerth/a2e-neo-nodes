/**
 * PROVISIONING_EXTERNAL soft-reroute worker.
 *
 * Sits BEFORE the existing 20-minute hard-cancel timeout
 * (provisioning-timeout.ts). When an external rental hasn't made
 * progress in REROUTE_SOFT_THRESHOLD_MS (default 8 min), instead of
 * letting it ride to the hard timeout, we:
 *
 *   1. Terminate the stuck rental on the original provider's side
 *      (e.g. delete the Vast.ai instance so we stop being billed)
 *   2. Re-route the same ComputeRequest to Shadeform — chosen because
 *      it's a meta-broker that aggregates Hyperstack, Latitude,
 *      MassedCompute, Crusoe, etc. behind a single API, giving the
 *      largest fallback pool
 *   3. Stamp the ComputeRequest.adminNote with `reroute:<original>->SHADEFORM`
 *      so a second reroute can't fire on the same request (idempotency
 *      without schema migration)
 *
 * If Shadeform also has no supply (or also gets stuck), the existing
 * 20-minute hard timeout in provisioning-timeout.ts takes over and
 * refunds the buyer cleanly. So this worker is a STRICT improvement:
 * cuts the typical bad-luck wait from 20 min to ~8 min when a faster
 * fallback is available, otherwise no behavior change.
 *
 * Why Shadeform and not "try each provider in turn":
 *   - One fallback path is dramatically simpler than a ladder
 *     (1 file vs 6, no per-provider exclusion list, no infinite-loop
 *     guard beyond the single adminNote check)
 *   - Shadeform IS the multi-provider option — under the hood it
 *     already routes across many underlying clouds
 *   - When we want a full ladder later (Vast → RunPod → Lambda → etc.)
 *     we extend this worker with an attemptedProviders schema column
 *     and a per-provider exclusion list. For now: one fallback is enough.
 *
 * Why adminNote-based tracking instead of a schema column:
 *   - No migration needed; ships in one commit
 *   - The reroute is meant to fire AT MOST ONCE per ComputeRequest, so
 *     a "did we already reroute this?" boolean is enough
 *   - When we generalize to N providers, we'll add a proper
 *     `attemptedProviders String[]` field on ComputeRequest. This worker
 *     becomes a no-op or migrates to read that field.
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
// includes() on the column. Stable token so future schema migrations
// can replace this with a typed column without losing the marker.
const REROUTE_MARKER = '[reroute-fired]'

// Providers we route AWAY from. Shadeform is omitted from the source
// list (we don't reroute Shadeform to itself) AND it's not in the
// destination list because IT is the destination. If we ever add more
// fallback destinations, this becomes per-source routing config.
const REROUTABLE_SOURCE_PROVIDERS = new Set([
  'VASTAI',
  'RUNPOD',
  'LAMBDA',
  'IONET',
  'PHALA',
  'VOLTAGEGPU',
  'HYPERSTACK',
])

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

  // Step 1: find ExternalRental rows that have been in PENDING status
  // for longer than SOFT_THRESHOLD_MS since CREATION, on a provider we
  // know how to route AWAY from.
  //
  // Why createdAt and NOT updatedAt: every provider's poll worker
  // (e.g. vastai-provision.ts pollVastAiRentalStatus) calls
  // prisma.externalRental.update() on every tick, even when nothing
  // changed, with at least `{status: newStatus, lastError: null}`.
  // Prisma's @updatedAt directive bumps the column on every update()
  // regardless of whether the data actually changed. So `updatedAt`
  // is essentially "wall-clock-now for any rental whose poll worker is
  // running" rather than "time since the provider made progress." A
  // healthy-but-slow Vast.ai rental would keep updatedAt fresh every
  // minute and never trigger the reroute despite being genuinely stuck.
  //
  // createdAt is immutable, so `createdAt + SOFT_THRESHOLD_MS < now`
  // accurately means "this rental has existed for N minutes and is
  // still not ACTIVE." That's the right signal for the reroute.
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
  // Step 2: load the parent ComputeRequest and verify it's still in
  // PROVISIONING_EXTERNAL AND hasn't been rerouted before.
  const cr = await prisma.computeRequest.findUnique({
    where: { id: er.computeRequestId },
    select: { id: true, status: true, adminNote: true, gpuTier: true, gpuCount: true },
  })
  if (!cr) return
  if (cr.status !== 'PROVISIONING_EXTERNAL') return
  if (cr.adminNote?.includes(REROUTE_MARKER)) return

  console.log(
    `[provisioning-reroute] rerouting ${cr.id} from ${er.provider} -> SHADEFORM ` +
      `(${cr.gpuCount}x ${cr.gpuTier}, stuck > ${Math.round(SOFT_THRESHOLD_MS / 60000)}min)`,
  )

  // Step 3: terminate the stuck rental on the source provider so we
  // stop paying for it. Best-effort; if it fails the buyer still gets
  // their compute via the new path and the existing
  // external-orphan-reconciler will clean up later.
  try {
    await terminateExternalRentalForRequest(
      prisma,
      cr.id,
      `Soft reroute: ${er.provider} took > ${Math.round(SOFT_THRESHOLD_MS / 60000)}min without progress`,
    )
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      console.error(
        `[provisioning-reroute] unknown-provider terminate for ${cr.id}: ${err.message}; continuing reroute`,
      )
    } else {
      console.error(
        `[provisioning-reroute] terminate-on-source failed for ${cr.id}; continuing reroute:`,
        err,
      )
    }
  }

  // Mark the prior ExternalRental as CLOSED so the original provider's
  // poll worker stops touching it and the hard-timeout worker doesn't
  // consider it again. terminateExternalRentalForRequest already does
  // this on success, but the catch-all above means we might still need
  // to mark it manually if the upstream call fell over.
  await prisma.externalRental.updateMany({
    where: { id: er.id, status: { in: ['PENDING', 'ACTIVE'] } },
    data: { status: 'CLOSED', lastNote: 'Closed by soft-reroute worker' },
  })

  // Step 4: flip ComputeRequest back to PENDING so
  // provisionShadeFormRental's status guard accepts the call, AND stamp
  // the adminNote with the reroute marker so this can't fire twice.
  const previousNote = cr.adminNote ?? ''
  const rerouteNote =
    `${REROUTE_MARKER} from ${er.provider} -> SHADEFORM at ${new Date().toISOString()}`
  await prisma.computeRequest.update({
    where: { id: cr.id },
    data: {
      status: 'PENDING',
      adminNote: previousNote
        ? `${previousNote}; ${rerouteNote}`
        : rerouteNote,
    },
  })

  // Step 5: call into shadeform-provision which performs the API call
  // + creates a fresh ExternalRental + flips status back to
  // PROVISIONING_EXTERNAL. If Shadeform also has no supply, this
  // throws — we restore the ComputeRequest to PROVISIONING_EXTERNAL so
  // the hard-timeout worker can handle it normally, but leave the
  // adminNote marker in place so a 2nd reroute doesn't fire.
  try {
    await provisionShadeFormRental(prisma, cr.id)
    console.log(
      `[provisioning-reroute] ${cr.id} successfully rerouted to SHADEFORM`,
    )
  } catch (err) {
    // Shadeform refused. Put the request back into PROVISIONING_EXTERNAL
    // with the original-provider's already-CLOSED rental record so the
    // hard timeout fires cleanly and refunds the buyer at the 20-min
    // mark. The adminNote stays stamped — we won't try again.
    console.error(
      `[provisioning-reroute] Shadeform fallback failed for ${cr.id}:`,
      err instanceof Error ? err.message : err,
    )
    await prisma.computeRequest.update({
      where: { id: cr.id, status: 'PENDING' },
      data: {
        status: 'PROVISIONING_EXTERNAL',
        adminNote:
          previousNote
            ? `${previousNote}; ${rerouteNote}; Shadeform also unavailable, falling through to hard-timeout`
            : `${rerouteNote}; Shadeform also unavailable, falling through to hard-timeout`,
      },
    })
  }
}
