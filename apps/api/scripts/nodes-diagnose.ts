/**
 * Generic node-eligibility diagnostic. Given an ID pattern (or --all)
 * and a tier, print every matching node and tell you which allocator
 * filter (if any) is excluding it.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *
 *   # All nodes the allocator considers for an H100 request
 *   pnpm --filter @a2e/api nodes:diagnose -- --tier H100
 *
 *   # Just your nodes (by ID prefix), against H100 routing
 *   pnpm --filter @a2e/api nodes:diagnose -- byog-w test-n --tier H100
 *
 *   # Every node (any tier), no tier filter
 *   pnpm --filter @a2e/api nodes:diagnose -- --all
 *
 * Mirrors the exact filter the compute-allocator uses in
 * apps/api/src/jobs/compute-allocator.ts so a green check here means
 * the allocator will pick the node up next tick.
 */

import { PrismaClient, type GpuTier } from '@a2e/database'

const prisma = new PrismaClient()
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000

async function main() {
  const args = process.argv.slice(2).flatMap(a => a.split(','))
  const all = args.includes('--all')
  const tierIdx = args.indexOf('--tier')
  const tier = tierIdx >= 0 ? (args[tierIdx + 1] as GpuTier) : null
  const idPatterns = args.filter(
    (a, i) => !a.startsWith('--') && i !== tierIdx + 1 && a.trim().length > 0,
  )

  if (!all && idPatterns.length === 0 && !tier) {
    console.error('Usage:')
    console.error('  pnpm --filter @a2e/api nodes:diagnose -- --all')
    console.error('  pnpm --filter @a2e/api nodes:diagnose -- <id-pattern> [<id-pattern> ...]')
    console.error('  pnpm --filter @a2e/api nodes:diagnose -- --tier H100')
    process.exit(1)
  }

  const where: Record<string, unknown> = {}
  if (idPatterns.length > 0) where.OR = idPatterns.map(p => ({ id: { contains: p } }))
  if (tier) where.gpuTier = tier

  const nodes = await prisma.node.findMany({
    where,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      gpuTier: true,
      status: true,
      currentJobId: true,
      assignedComputeRequestId: true,
      pendingDeletion: true,
      lastHeartbeat: true,
      agentVersion: true,
      region: true,
      nodeRunnerId: true,
      operatorRatePerHour: true,
      customRatePerHour: true,
      nodeRunner: { select: { reputationScore: true, reputationTier: true } },
    },
  })

  if (nodes.length === 0) {
    console.log('No nodes matched the given pattern.')
    return
  }

  const now = Date.now()
  const heartbeatFloor = new Date(now - HEARTBEAT_FRESH_MS)

  console.log(`=== ${nodes.length} node(s) inspected ===`)
  console.log('')

  let eligibleCount = 0
  for (const n of nodes) {
    const hbAgeSec = Math.floor((now - n.lastHeartbeat.getTime()) / 1000)
    const reasons: string[] = []
    if (n.status !== 'ONLINE') reasons.push(`status=${n.status} (need ONLINE)`)
    if (n.currentJobId) reasons.push(`currentJobId=${n.currentJobId.slice(0, 8)} (need null)`)
    if (n.assignedComputeRequestId) reasons.push(`assignedComputeRequestId=${n.assignedComputeRequestId.slice(0, 8)} (need null)`)
    if (n.pendingDeletion) reasons.push('pendingDeletion=true (need false)')
    if (!n.agentVersion) reasons.push('agentVersion=null (need non-null)')
    if (n.lastHeartbeat < heartbeatFloor && !n.id.startsWith('test-c2-')) {
      reasons.push(`heartbeat too old (${hbAgeSec}s, threshold 120s)`)
    }

    const eligible = reasons.length === 0
    if (eligible) eligibleCount++

    const repTier = n.nodeRunner?.reputationTier ?? 'NULL'
    const repScore = n.nodeRunner?.reputationScore ?? 'null'
    const effectiveRate = n.operatorRatePerHour ?? n.customRatePerHour ?? null

    console.log(`${eligible ? '✅' : '❌'} ${n.id}`)
    console.log(`     gpuTier=${n.gpuTier}  status=${n.status}  region=${n.region ?? 'null'}`)
    console.log(`     hb=${hbAgeSec}s ago  agent=${n.agentVersion ?? 'null'}  pendingDel=${n.pendingDeletion}`)
    console.log(`     currentJobId=${n.currentJobId ?? 'null'}  assigned=${n.assignedComputeRequestId ?? 'null'}`)
    console.log(`     nodeRunnerId=${n.nodeRunnerId ?? 'null'}  reputation=${repTier}/${repScore}`)
    console.log(`     operatorRate=${n.operatorRatePerHour ?? 'null'}  customRate=${n.customRatePerHour ?? 'null'}  effective=$${effectiveRate ?? 'falls-to-floor'}/hr`)
    if (!eligible) {
      for (const r of reasons) console.log(`     ❌ ${r}`)
    }
    console.log('')
  }

  console.log(`Summary: ${eligibleCount}/${nodes.length} node(s) would pass the allocator filter.`)
  if (eligibleCount < nodes.length) {
    console.log('Use nodes:mark-online to re-arm the failing ones.')
  }
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
