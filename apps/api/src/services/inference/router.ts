/**
 * Track 5 / E2.0 — inference request router.
 *
 * Picks the best available InferenceWorker to serve a given (model)
 * request. Mirrors the compute-allocator's tiebreak chain so operators
 * see consistent routing behavior across compute and inference:
 *
 *   1. Worker must serve the requested model (servedModels contains it)
 *   2. Worker status must be READY or SERVING (excludes PENDING /
 *      DEGRADED / DRAINED)
 *   3. Worker must have a fresh heartbeat (< 90s old)
 *   4. Worker must have capacity (current in-flight requests < capacity)
 *   5. Among the survivors, sort by:
 *        a. Operator reputation desc (nulls last)
 *        b. p50 latency asc (faster wins)
 *        c. Most recent heartbeat (tiebreaker)
 *
 * Returns null when no eligible worker exists; the caller (the
 * /v1/chat/completions endpoint) decides whether to fall through to
 * an external provider configured on ModelPricing.metadata, or to
 * surface a 503 to the buyer.
 *
 * This module is intentionally read-only — it queries InferenceWorker
 * + InferenceRequest but never mutates them. The endpoint creates the
 * InferenceRequest row itself, so the router can be called multiple
 * times during retries without producing duplicate audit rows.
 */

import type { PrismaClient } from '@a2e/database'

const HEARTBEAT_FRESH_MS = 90 * 1000

export interface RoutedWorker {
  id: string
  nodeId: string
  baseUrl: string
  /** Hash of the operator's bearer token. The router does NOT decode
   *  this; the caller compares against a fresh request signature when
   *  the worker handshake supports it. For initial E2 the router just
   *  returns the hash for traceability and the platform doesn't
   *  actually authenticate to the operator's worker (the worker
   *  trusts the platform's egress IP). */
  authTokenHash: string
  /** Used by the endpoint to add the right Bearer header if/when
   *  workers start requiring it. */
  p50LatencyMs: number | null
  capacity: number
  currentInflight: number
  reputationScore: number | null
}

export interface PickInferenceWorkerArgs {
  model: string
  /** Optional GPU tier preference passed by the buyer (e.g. they
   *  want their request served on Hopper-class hardware only). When
   *  set, only workers on a Node of the matching tier are considered.
   *  Null/undefined disables the filter. */
  preferredGpuTier?: string | null
}

/**
 * Returns the best worker for a request, or null when nothing is
 * eligible. Read-only — the caller handles row creation.
 */
export async function pickInferenceWorker(
  prisma: PrismaClient,
  args: PickInferenceWorkerArgs,
): Promise<RoutedWorker | null> {
  const freshAfter = new Date(Date.now() - HEARTBEAT_FRESH_MS)

  // Pull all candidate workers + their node + inflight count in one
  // pass. The model match uses a substring search on servedModels
  // because the column is a comma-separated list; Prisma's contains
  // is a simple SQL LIKE which is fine at our scale.
  const candidates = await prisma.inferenceWorker.findMany({
    where: {
      status: { in: ['READY', 'SERVING'] },
      lastHeartbeat: { gte: freshAfter },
      servedModels: { contains: args.model },
    },
    include: {
      node: {
        select: {
          gpuTier: true,
          nodeRunner: { select: { reputationScore: true } },
        },
      },
      _count: {
        select: {
          inferenceRequests: {
            where: { status: { in: ['ROUTING', 'STREAMING'] } },
          },
        },
      },
    },
  })

  // Pre-filter on tier preference + servedModels exact match (contains
  // can over-match: model "gpt-4o" matches "gpt-4o-mini" servedModels).
  // Explicit token check on comma-split list is cheap given pool size.
  const eligible = candidates.filter((w) => {
    const tokens = w.servedModels.split(',').map((s) => s.trim())
    if (!tokens.includes(args.model)) return false
    if (args.preferredGpuTier && w.node.gpuTier !== args.preferredGpuTier) return false
    if (w._count.inferenceRequests >= w.capacity) return false
    return true
  })

  if (eligible.length === 0) return null

  // Sort: reputation desc (nulls last) → latency asc (nulls last) →
  // freshest heartbeat. Matches the allocator's tier-2/3/4 chain.
  const sorted = eligible.slice().sort((a, b) => {
    const aRep = a.node.nodeRunner?.reputationScore ?? -Infinity
    const bRep = b.node.nodeRunner?.reputationScore ?? -Infinity
    if (aRep !== bRep) return bRep - aRep

    const aLat = a.p50LatencyMs ?? Number.POSITIVE_INFINITY
    const bLat = b.p50LatencyMs ?? Number.POSITIVE_INFINITY
    if (aLat !== bLat) return aLat - bLat

    return b.lastHeartbeat.getTime() - a.lastHeartbeat.getTime()
  })

  const winner = sorted[0]!
  return {
    id: winner.id,
    nodeId: winner.nodeId,
    baseUrl: winner.baseUrl.replace(/\/+$/, ''),
    authTokenHash: winner.authTokenHash,
    p50LatencyMs: winner.p50LatencyMs,
    capacity: winner.capacity,
    currentInflight: winner._count.inferenceRequests,
    reputationScore: winner.node.nodeRunner?.reputationScore ?? null,
  }
}

/**
 * After a stream closes, the meter calls this to roll the observed
 * latency into the worker's p50LatencyMs stat. Lightweight EMA so the
 * value moves smoothly without storing a sliding window. Alpha 0.2
 * gives the most recent 5 samples ~67% weight.
 */
export async function recordWorkerLatency(
  prisma: PrismaClient,
  workerId: string,
  latencyMs: number,
): Promise<void> {
  if (latencyMs < 0) return
  const worker = await prisma.inferenceWorker.findUnique({
    where: { id: workerId },
    select: { p50LatencyMs: true },
  })
  if (!worker) return
  const prev = worker.p50LatencyMs ?? latencyMs
  const next = Math.round(prev * 0.8 + latencyMs * 0.2)
  await prisma.inferenceWorker.update({
    where: { id: workerId },
    data: { p50LatencyMs: next },
  })
}
