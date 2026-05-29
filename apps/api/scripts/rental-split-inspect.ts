/**
 * Track 5 / M0.3 — rental split inspector.
 *
 * Two modes, both read-only by default:
 *
 *   pnpm --filter @a2e/api rental-split:inspect
 *     -> list the most recent COMPLETED rentals and show whether each
 *        has been split (audit table check). Useful sanity scan after
 *        flipping REVENUE_SPLIT_ENABLED.
 *
 *   pnpm --filter @a2e/api rental-split:inspect <computeRequestId>
 *     -> show the full split for one rental: per-node breakdown of
 *        gross / cost / operator / staking / treasury, the Earning
 *        row(s) written under market=RENTAL, and the staking +
 *        treasury BalanceTransaction entries.
 *
 *   pnpm --filter @a2e/api rental-split:inspect <id> --dry-run-credit
 *     -> simulate creditCompletedRental on the request WITHOUT
 *        writing anything. Shows exactly what would be credited
 *        if we ran the helper now. Useful for verifying the math
 *        on a real rental before flipping the kill switch.
 *
 *   pnpm --filter @a2e/api rental-split:inspect <id> --credit-now
 *     -> ACTUALLY run creditCompletedRental for this rental. Only
 *        usable when REVENUE_SPLIT_ENABLED=true. Idempotent — re-run
 *        is safe. Use to backfill any rentals that completed before
 *        the flag flipped (or to recover from a previous failure).
 */
import { prisma } from '@a2e/database'
import { computeCostOfService } from '../src/services/revenue/cost-of-service.js'
import {
  creditCompletedRental,
} from '../src/services/revenue/rental-credit.js'
import { isRevenueSplitEnabled } from '../src/services/revenue/split.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const computeRequestId = args.find((a) => !a.startsWith('--'))
  const dryRunCredit = args.includes('--dry-run-credit')
  const creditNow = args.includes('--credit-now')

  console.log(`REVENUE_SPLIT_ENABLED = ${isRevenueSplitEnabled()}`)
  console.log()

  if (!computeRequestId) {
    return listRecent()
  }

  await inspectOne(computeRequestId, { dryRunCredit, creditNow })
}

async function listRecent(): Promise<void> {
  const recents = await prisma.computeRequest.findMany({
    where: { status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      gpuTier: true,
      gpuCount: true,
      totalCost: true,
      accruedCost: true,
      completedAt: true,
      allocatedNodeIds: true,
    },
  })

  if (recents.length === 0) {
    console.log('No COMPLETED rentals in the database.')
    return
  }

  const ids = recents.map((r) => r.id)
  const splits = await prisma.revenueShareEntry.findMany({
    where: { referenceId: { startsWith: '' }, sourceTxType: 'SPEND_RENTAL' },
    select: { referenceId: true, splitEnabled: true, operatorTotalUsd: true },
  })
  const byReq = new Map<string, { count: number; enabled: boolean | null; total: number }>()
  for (const s of splits) {
    const reqId = s.referenceId.split(':')[0] ?? s.referenceId
    if (!ids.includes(reqId)) continue
    const e = byReq.get(reqId) ?? { count: 0, enabled: null, total: 0 }
    e.count += 1
    e.enabled = s.splitEnabled
    e.total += s.operatorTotalUsd
    byReq.set(reqId, e)
  }

  console.log(`20 most-recent COMPLETED rentals:`)
  console.log()
  console.log(`  ${'ComputeRequest.id'.padEnd(28)} ${'tier'.padEnd(6)} ${'gross'.padEnd(10)} ${'split?'.padEnd(8)} ${'mode'.padEnd(8)} per-node-credits`)
  for (const r of recents) {
    const audit = byReq.get(r.id)
    const splitMark = audit ? `${audit.count}/${r.allocatedNodeIds.length}` : '-'
    const mode = audit?.enabled === true ? 'SPLIT' : audit?.enabled === false ? 'LEGACY' : '-'
    const gross = (r.accruedCost ?? r.totalCost).toFixed(2)
    console.log(`  ${r.id.padEnd(28)} ${r.gpuTier.padEnd(6)} $${gross.padEnd(9)} ${splitMark.padEnd(8)} ${mode.padEnd(8)} ${audit ? `op=$${audit.total.toFixed(2)}` : ''}`)
  }
  console.log()
  console.log(`Re-run with an id to drill in: pnpm --filter @a2e/api rental-split:inspect <id>`)
}

async function inspectOne(
  computeRequestId: string,
  flags: { dryRunCredit: boolean; creditNow: boolean },
): Promise<void> {
  const cr = await prisma.computeRequest.findUnique({
    where: { id: computeRequestId },
    select: {
      id: true,
      status: true,
      activatedAt: true,
      completedAt: true,
      expiresAt: true,
      totalCost: true,
      accruedCost: true,
      allocatedNodeIds: true,
      gpuTier: true,
      gpuCount: true,
    },
  })
  if (!cr) {
    console.log(`ComputeRequest ${computeRequestId} not found.`)
    process.exitCode = 1
    return
  }

  const gross = cr.accruedCost ?? cr.totalCost
  const nodeCount = cr.allocatedNodeIds.length
  const grossPerNode = nodeCount > 0 ? gross / nodeCount : 0

  console.log(`ComputeRequest ${cr.id}`)
  console.log(`  status        = ${cr.status}`)
  console.log(`  tier x count  = ${cr.gpuTier} x ${cr.gpuCount}`)
  console.log(`  totalCost     = $${cr.totalCost.toFixed(4)}`)
  console.log(`  accruedCost   = $${(cr.accruedCost ?? 0).toFixed(4)}`)
  console.log(`  gross (used)  = $${gross.toFixed(4)}`)
  console.log(`  allocatedNodes= [${cr.allocatedNodeIds.join(', ')}]`)
  console.log(`  duration      = ${formatDuration(cr.activatedAt, cr.completedAt, cr.expiresAt)}`)
  console.log()

  if (nodeCount === 0) {
    console.log(`No allocated nodes; nothing to split.`)
    return
  }

  const durationSeconds = computeDurationSeconds(cr.activatedAt, cr.completedAt, cr.expiresAt)

  console.log(`Per-node breakdown (gross/node = $${grossPerNode.toFixed(4)}):`)
  console.log()
  for (const nodeId of cr.allocatedNodeIds) {
    const node = await prisma.node.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        gpuTier: true,
        declaredGpuSku: true,
        powerRegion: true,
        nodeRunner: { select: { userId: true } },
      },
    })
    if (!node) {
      console.log(`  Node ${nodeId}: NOT FOUND`)
      continue
    }
    const breakdown = await computeCostOfService(prisma, { nodeId, durationSeconds })
    const cost = breakdown.totalUsd
    const net = Math.max(0, grossPerNode - cost)
    const operatorTotal = cost + net * 0.5
    const staking = net * 0.25
    const treasury = net * 0.25

    const audit = await prisma.revenueShareEntry.findUnique({
      where: { referenceId: `${cr.id}:${nodeId}` },
      select: {
        operatorTotalUsd: true,
        stakingShareUsd: true,
        treasuryShareUsd: true,
        splitEnabled: true,
        createdAt: true,
      },
    })

    console.log(`  Node ${nodeId}`)
    console.log(`    SKU resolved   ${breakdown.gpuSku}  (declared=${node.declaredGpuSku ?? '-'}  region=${node.powerRegion ?? 'GLOBAL'})`)
    console.log(`    operator user  ${node.nodeRunner?.userId ?? '(no nodeRunner)'}`)
    console.log(`    cost ($/h)     $${breakdown.totalHourly.toFixed(4)}/h x ${durationSeconds}s = $${cost.toFixed(4)}`)
    console.log(`    EXPECTED split  operator $${operatorTotal.toFixed(4)}  staking $${staking.toFixed(4)}  treasury $${treasury.toFixed(4)}`)
    if (audit) {
      console.log(`    AUDIT row       operator $${audit.operatorTotalUsd.toFixed(4)}  staking $${audit.stakingShareUsd.toFixed(4)}  treasury $${audit.treasuryShareUsd.toFixed(4)}`)
      console.log(`    audit mode      ${audit.splitEnabled ? 'SPLIT (kill switch ON)' : 'LEGACY (kill switch OFF)'}  at ${audit.createdAt.toISOString()}`)
    } else {
      console.log(`    AUDIT row       (none yet — not credited)`)
    }
    console.log()
  }

  if (flags.dryRunCredit) {
    console.log(`--dry-run-credit was set; not writing anything.`)
    return
  }

  if (flags.creditNow) {
    if (!isRevenueSplitEnabled()) {
      console.log(`--credit-now requested but REVENUE_SPLIT_ENABLED is false. No-op.`)
      return
    }
    console.log(`Running creditCompletedRental(${cr.id})...`)
    const result = await creditCompletedRental(prisma, { computeRequestId: cr.id })
    console.log(`Done. applied=${result.applied}, ${result.perNode.length} per-node results.`)
    for (const r of result.perNode) {
      console.log(`  ${r.nodeId}: firstWrite=${r.firstWrite}  operator=$${r.operatorTotalUsd.toFixed(4)}  staking=$${r.stakingShareUsd.toFixed(4)}  treasury=$${r.treasuryShareUsd.toFixed(4)}`)
    }
  }
}

function computeDurationSeconds(activatedAt: Date | null, completedAt: Date | null, expiresAt: Date | null): number {
  if (activatedAt && completedAt) {
    return Math.max(0, Math.floor((completedAt.getTime() - activatedAt.getTime()) / 1000))
  }
  if (activatedAt && expiresAt) {
    return Math.max(0, Math.floor((expiresAt.getTime() - activatedAt.getTime()) / 1000))
  }
  return 0
}

function formatDuration(activatedAt: Date | null, completedAt: Date | null, expiresAt: Date | null): string {
  const s = computeDurationSeconds(activatedAt, completedAt, expiresAt)
  if (s === 0) return '0s'
  const h = s / 3600
  return `${s}s (${h.toFixed(2)}h)`
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
