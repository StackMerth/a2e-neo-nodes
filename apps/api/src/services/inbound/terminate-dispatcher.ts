/**
 * T6 — provider-agnostic ExternalRental termination dispatcher.
 *
 * Before T5e, the codebase called terminateLambdaRental directly from
 * both the rental-expiry tick (M2) AND the buyer-compute early-
 * terminate route. When T5e introduced RunPod as a 2nd provider, those
 * call sites started silently leaking money: a RunPod-provisioned
 * rental ending would never tell RunPod to stop the pod, so RunPod
 * kept billing our account until manual cleanup.
 *
 * This helper dispatches by provider so a single call site handles
 * every supplier. Adding a new provider (Crusoe, CoreWeave, etc.) is:
 *   1. Add its terminate function import here
 *   2. Add a case to the switch
 *
 * The dispatcher is intentionally narrow — it does NOT handle the
 * accounting / refund / notification logic. Those stay in the caller
 * (rental-expiry / buyer-compute / admin-compute) because they're
 * provider-agnostic already. This file is purely "stop billing on
 * the external provider, mark the row CLOSED."
 *
 * Idempotency: each per-provider terminate function is already
 * idempotent (no-ops on CLOSED rows, tolerates provider 404s). So
 * this dispatcher is safe to call multiple times.
 */

import type { PrismaClient } from '@a2e/database'
import { terminateLambdaRental } from './lambda-provision.js'
import { terminateRunPodRental } from './runpod-provision.js'
import { terminatePhalaRental } from './phala-provision.js'
import { terminateIoNetRental } from './ionet-provision.js'

export class UnknownProviderError extends Error {
  constructor(public provider: string, public externalRentalId: string) {
    super(`Unknown ExternalRental.provider "${provider}" on ${externalRentalId}; cannot terminate.`)
    this.name = 'UnknownProviderError'
  }
}

/**
 * Terminate the ExternalRental's provider instance (Lambda VM, RunPod
 * pod, etc.) and mark the row CLOSED. Looks up provider from the row;
 * routes to the right terminate function.
 *
 * No-op when:
 *   - ExternalRental row not found (already deleted in a race)
 *   - ExternalRental.status === 'CLOSED' (already terminated)
 *
 * Throws:
 *   - UnknownProviderError when provider doesn't match any known
 *     dispatcher case. The caller should log + alert; rentals stuck
 *     in this state need manual ops to terminate on the provider's
 *     dashboard before we can clean the row up safely.
 *   - any underlying provider terminate error (network, 5xx, etc.).
 *     The caller decides whether to retry or surface to the buyer.
 */
export async function terminateExternalRental(
  prisma: PrismaClient,
  externalRentalId: string,
  reason: string,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
    select: { id: true, status: true, provider: true },
  })
  if (!row) return
  if (row.status === 'CLOSED') return

  switch (row.provider) {
    case 'LAMBDA':
      await terminateLambdaRental(prisma, externalRentalId, reason)
      return
    case 'RUNPOD':
      await terminateRunPodRental(prisma, externalRentalId, reason)
      return
    case 'PHALA':
      await terminatePhalaRental(prisma, externalRentalId, reason)
      return
    case 'IONET':
      await terminateIoNetRental(prisma, externalRentalId, reason)
      return
    default:
      throw new UnknownProviderError(row.provider, externalRentalId)
  }
}

/**
 * Convenience for callers that have a ComputeRequest id, not an
 * ExternalRental id. Looks up the linked ExternalRental and dispatches.
 * No-op when the request has no external rental (internal-node-only
 * rentals don't touch this path).
 */
export async function terminateExternalRentalForRequest(
  prisma: PrismaClient,
  computeRequestId: string,
  reason: string,
): Promise<void> {
  const row = await prisma.externalRental.findUnique({
    where: { computeRequestId },
    select: { id: true },
  })
  if (!row) return
  await terminateExternalRental(prisma, row.id, reason)
}
