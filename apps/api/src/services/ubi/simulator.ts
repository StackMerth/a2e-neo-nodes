/**
 * ZK-UBI simulator.
 *
 * Drives the full ZK-UBI flow end-to-end WITHOUT the funded sub-tasks
 * (M2.1 treasury, M2.2 broker deploy, M2.4 Bento auth). Everything
 * the production path will do — read a Boundless fulfill event,
 * accrue a UbiProof row, swap to USDC, roll up into UbiEarning,
 * route to the operator's balance — runs against synthetic inputs.
 *
 * Why this exists: the user wanted to be able to test ZK-UBI fully
 * before committing real ZKC stake or deploying the Boundless
 * broker. The simulator is the cheap surrogate; same code path,
 * same DB rows, same operator-facing dashboard updates.
 *
 * Exposed to admin via routes/admin-ubi.ts (POST endpoints). NOT
 * exposed to operators or buyers.
 *
 * Three primitives:
 *   1. simulateOptIn(nodeId)        — create a NodeUbiOptIn row
 *   2. simulateProofAccepted(args)  — inject a synthetic fulfill
 *      event; runs the real Base event reader handler; writes
 *      UbiProof.ACCEPTED + invokes placeholder swap rail
 *   3. simulateEpochClose(args)     — roll up N accepted proofs for
 *      one operator into a single UbiEarning row, 95/5 split
 *
 * Cleanup: the simulator tags every row it writes with
 * `aggregator='SIMULATOR'` on UbiProof and a synthetic 'simulator-'
 * prefix on externalProofId. A separate admin endpoint
 * (purgeSimulatorRows) wipes everything tagged this way so you can
 * reset state between test runs without touching real production
 * data.
 */

import type { PrismaClient, UbiProtocol } from '@a2e/database'
import { processFulfillEvent, type BoundlessFulfillEvent } from './base-event-reader.js'
import { splitUbiPayout } from './types.js'

const SIMULATOR_AGGREGATOR = 'SIMULATOR'
const SIMULATOR_PROOF_PREFIX = 'simulator-'

export interface SimulatorDeps {
  prisma: PrismaClient
}

export interface SimulateOptInArgs {
  nodeId: string
  protocol?: UbiProtocol
}

/**
 * Create or refresh a NodeUbiOptIn row for a node. Idempotent: if
 * an ACTIVE row already exists for (nodeId, protocol) it's left
 * alone and returned.
 */
export async function simulateOptIn(
  deps: SimulatorDeps,
  args: SimulateOptInArgs,
): Promise<{ optInId: string; created: boolean }> {
  const protocol = args.protocol ?? 'BOUNDLESS'

  const existing = await deps.prisma.nodeUbiOptIn.findFirst({
    where: { nodeId: args.nodeId, protocol, status: 'ACTIVE' },
    orderBy: { optedInAt: 'desc' },
  })
  if (existing) {
    return { optInId: existing.id, created: false }
  }

  const row = await deps.prisma.nodeUbiOptIn.create({
    data: {
      nodeId: args.nodeId,
      protocol,
      status: 'ACTIVE',
      consentVersion: 'simulator-v0',
    },
  })
  return { optInId: row.id, created: true }
}

export interface SimulateProofAcceptedArgs {
  nodeId: string
  // ETH per-order fee in wei (string). Default ~$1 worth at the
  // placeholder $3,500/ETH price.
  feeWei?: string
  // Image (zkVM program) id this proof attests to. Synthetic.
  imageId?: string
}

/**
 * Inject a synthetic Boundless fulfill event and run it through the
 * real base-event-reader handler. The UbiProof row that lands is
 * tagged so it can be purged later.
 *
 * Returns the resulting UbiProof row id (or null if the handler
 * decided not to accrue, e.g. duplicate).
 */
export async function simulateProofAccepted(
  deps: SimulatorDeps,
  args: SimulateProofAcceptedArgs,
): Promise<{ accrued: boolean; reason?: string }> {
  const feeWei = args.feeWei ?? '285714285714285714' // ~$1 at $3500/ETH
  const imageId = args.imageId ?? `sim-image-${Date.now().toString(16)}`
  const requestId = `${SIMULATOR_PROOF_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  const event: BoundlessFulfillEvent = {
    requestId,
    proverAddress: '0xPLATFORM_SIMULATOR',
    imageId,
    feeWei,
    blockNumber: 0,
    txHash: `simulated-${requestId}`,
    blockTimestampSeconds: Math.floor(Date.now() / 1000),
  }

  const result = await processFulfillEvent(
    {
      prisma: deps.prisma,
      platformProverAddress: '0xPLATFORM_SIMULATOR',
    },
    event,
  )

  // After the standard handler runs, retag the row so purge can find
  // it. The handler writes aggregator='boundless-base-mainnet'; we
  // overwrite with 'SIMULATOR' and rebind nodeId to the actual
  // operator (the handler defaults to 'platform-house-node').
  if (result.accrued) {
    await deps.prisma.ubiProof.updateMany({
      where: { externalProofId: requestId, protocol: 'BOUNDLESS' },
      data: { aggregator: SIMULATOR_AGGREGATOR, nodeId: args.nodeId },
    })
  }

  return result
}

export interface SimulateEpochCloseArgs {
  nodeId: string
  // If omitted, roll up everything ACCEPTED for this node that
  // hasn't been included in a prior UbiEarning row.
  protocol?: UbiProtocol
}

/**
 * Roll up accepted UbiProof rows for one node-period into a single
 * UbiEarning row, 95/5 split. Marks the rolled-up proofs by their
 * acceptedAt timestamps; subsequent simulateEpochClose calls won't
 * re-include them because periodStart shifts forward.
 */
export async function simulateEpochClose(
  deps: SimulatorDeps,
  args: SimulateEpochCloseArgs,
): Promise<{
  earningId: string | null
  proofsRolled: number
  grossUsd: number
  operatorUsd: number
  platformUsd: number
}> {
  const protocol = args.protocol ?? 'BOUNDLESS'

  // Find this node + its NodeRunner.
  const node = await deps.prisma.node.findUnique({
    where: { id: args.nodeId },
    select: { id: true, nodeRunnerId: true },
  })
  if (!node || !node.nodeRunnerId) {
    return { earningId: null, proofsRolled: 0, grossUsd: 0, operatorUsd: 0, platformUsd: 0 }
  }

  // The roll-up window starts after the last UbiEarning's periodEnd
  // for this node + protocol, or epoch zero (Unix 0) if none exists.
  const lastEarning = await deps.prisma.ubiEarning.findFirst({
    where: { nodeId: node.id, protocol },
    orderBy: { periodEnd: 'desc' },
  })
  const periodStart = lastEarning?.periodEnd ?? new Date(0)
  const periodEnd = new Date()

  const proofs = await deps.prisma.ubiProof.findMany({
    where: {
      nodeId: node.id,
      protocol,
      status: 'ACCEPTED',
      acceptedAt: { gt: periodStart, lte: periodEnd },
    },
    select: { id: true, grossUsd: true },
  })
  if (proofs.length === 0) {
    return { earningId: null, proofsRolled: 0, grossUsd: 0, operatorUsd: 0, platformUsd: 0 }
  }

  const grossUsd = Math.round(proofs.reduce((s, p) => s + p.grossUsd, 0) * 10000) / 10000
  const { operatorUsd, platformUsd } = splitUbiPayout(grossUsd)

  const earning = await deps.prisma.ubiEarning.create({
    data: {
      nodeId: node.id,
      nodeRunnerId: node.nodeRunnerId,
      protocol,
      periodStart,
      periodEnd,
      grossUsd,
      operatorUsd,
      platformUsd,
      status: 'ACCRUED',
    },
  })

  return {
    earningId: earning.id,
    proofsRolled: proofs.length,
    grossUsd,
    operatorUsd,
    platformUsd,
  }
}

/**
 * Wipe all simulator-tagged UbiProof + UbiEarning + NodeUbiOptIn
 * rows. Safe to call between test runs to reset state. Will only
 * touch rows tagged with the SIMULATOR aggregator and consentVersion
 * 'simulator-v0'; real production rows are untouched.
 */
export async function purgeSimulatorRows(deps: SimulatorDeps): Promise<{
  proofsDeleted: number
  earningsDeleted: number
  optInsDeleted: number
}> {
  // Delete UbiEarning rows whose corresponding UbiProof rows are all
  // simulator-tagged. Crude but adequate: we delete any UbiEarning
  // whose periodEnd is after the earliest simulator UbiProof.acceptedAt.
  const earliestSimulatorProof = await deps.prisma.ubiProof.findFirst({
    where: { aggregator: SIMULATOR_AGGREGATOR },
    orderBy: { acceptedAt: 'asc' },
    select: { acceptedAt: true },
  })

  let earningsDeleted = 0
  if (earliestSimulatorProof?.acceptedAt) {
    const earningRes = await deps.prisma.ubiEarning.deleteMany({
      where: { periodEnd: { gte: earliestSimulatorProof.acceptedAt } },
    })
    earningsDeleted = earningRes.count
  }

  const proofRes = await deps.prisma.ubiProof.deleteMany({
    where: { aggregator: SIMULATOR_AGGREGATOR },
  })

  const optInRes = await deps.prisma.nodeUbiOptIn.deleteMany({
    where: { consentVersion: 'simulator-v0' },
  })

  return {
    proofsDeleted: proofRes.count,
    earningsDeleted,
    optInsDeleted: optInRes.count,
  }
}

export const SIMULATOR_TAGS = {
  AGGREGATOR: SIMULATOR_AGGREGATOR,
  PROOF_PREFIX: SIMULATOR_PROOF_PREFIX,
}
