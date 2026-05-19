/**
 * C2 wave 2 test helper — dump every relevant field on every test-c2-*
 * Node so we can see which one is being rejected by which filter.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c2:inspect-nodes
 *
 * Prints, for each test-c2-* node:
 *   - gpuTier, status, currentJobId, assignedComputeRequestId,
 *     pendingDeletion, lastHeartbeat (age in seconds),
 *     region, isResidential, agentVersion, nodeRunnerId
 *
 * Then runs the public-listings filter ONLY (status ONLINE, idle,
 * heartbeat fresh, has nodeRunner) and reports which test nodes pass.
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
  const now = Date.now()
  const heartbeatFloor = new Date(now - HEARTBEAT_FRESH_MS)

  const nodes = await prisma.node.findMany({
    where: { id: { startsWith: 'test-c2-' } },
    select: {
      id: true,
      gpuTier: true,
      status: true,
      currentJobId: true,
      assignedComputeRequestId: true,
      pendingDeletion: true,
      lastHeartbeat: true,
      region: true,
      isResidential: true,
      agentVersion: true,
      nodeRunnerId: true,
    },
    orderBy: { id: 'asc' },
  })

  if (nodes.length === 0) {
    console.log('No test-c2-* nodes exist. Run c2:seed-node first.')
    return
  }

  console.log(`=== ${nodes.length} test-c2-* node(s) ===`)
  for (const n of nodes) {
    const hbAge = Math.floor((now - n.lastHeartbeat.getTime()) / 1000)
    console.log('')
    console.log(`  ${n.id}`)
    console.log(`    gpuTier                  : ${n.gpuTier}`)
    console.log(`    status                   : ${n.status}`)
    console.log(`    currentJobId             : ${n.currentJobId ?? 'null'}`)
    console.log(`    assignedComputeRequestId : ${n.assignedComputeRequestId ?? 'null'}`)
    console.log(`    pendingDeletion          : ${n.pendingDeletion}`)
    console.log(`    lastHeartbeat            : ${n.lastHeartbeat.toISOString()} (${hbAge}s ago)`)
    console.log(`    region                   : ${n.region ?? 'null'}`)
    console.log(`    isResidential            : ${n.isResidential}`)
    console.log(`    agentVersion             : ${n.agentVersion ?? 'null'}`)
    console.log(`    nodeRunnerId             : ${n.nodeRunnerId ?? 'null'}`)
  }

  // Apply the SAME where clause the public /v1/public/listings endpoint
  // uses. Whatever survives is what the marketplace will display.
  const listable = await prisma.node.findMany({
    where: {
      id: { startsWith: 'test-c2-' },
      status: 'ONLINE',
      currentJobId: null,
      assignedComputeRequestId: null,
      pendingDeletion: false,
      lastHeartbeat: { gte: heartbeatFloor },
      nodeRunner: { isNot: null },
    },
    select: { id: true },
  })

  console.log('')
  console.log(`=== Listable under marketplace filter: ${listable.length} ===`)
  for (const n of listable) {
    console.log(`  ✅ ${n.id}`)
  }

  // For the missing ones, point at the most likely cause per node.
  const listableIds = new Set(listable.map((n) => n.id))
  const missed = nodes.filter((n) => !listableIds.has(n.id))
  if (missed.length > 0) {
    console.log('')
    console.log('=== Why these are filtered out ===')
    for (const n of missed) {
      const reasons: string[] = []
      if (n.status !== 'ONLINE') reasons.push(`status=${n.status}`)
      if (n.currentJobId) reasons.push('currentJobId is set')
      if (n.assignedComputeRequestId) reasons.push(`assignedComputeRequestId=${n.assignedComputeRequestId}`)
      if (n.pendingDeletion) reasons.push('pendingDeletion=true')
      if (n.lastHeartbeat < heartbeatFloor) {
        const age = Math.floor((now - n.lastHeartbeat.getTime()) / 1000)
        reasons.push(`heartbeat too old (${age}s, threshold 120s)`)
      }
      if (!n.nodeRunnerId) reasons.push('nodeRunnerId is null')
      console.log(`  ❌ ${n.id}: ${reasons.join(', ') || 'unknown'}`)
    }
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
