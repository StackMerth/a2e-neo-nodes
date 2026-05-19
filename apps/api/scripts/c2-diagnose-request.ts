/**
 * C2 wave 2 test helper — print full state of a ComputeRequest so you
 * can see exactly why the allocator hasn't picked it up. Common stuck
 * states:
 *
 *   - txConfirmed: false       -> run pnpm --filter @a2e/api c2:confirm-tx <txHash>
 *   - status: WAITLISTED       -> eligibility check rejected; see eligibilityFlags
 *   - status: PENDING + flags=['WAITING_ON_CAPACITY']
 *                              -> allocator ran but no matching idle node was free
 *   - status: PENDING + flags=['NO_REGION_CAPACITY']
 *                              -> region pinned, no nodes in that region online
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c2:diagnose-request <txHash OR requestId>
 *
 * Examples:
 *   pnpm --filter @a2e/api c2:diagnose-request TEST_TX_C2_INFERENCE_ASAD
 *   pnpm --filter @a2e/api c2:diagnose-request clxyz123abc456
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('Usage: pnpm --filter @a2e/api c2:diagnose-request <txHash OR requestId>')
    process.exit(1)
  }

  const request = await prisma.computeRequest.findFirst({
    where: { OR: [{ txHash: arg }, { id: arg }] },
    select: {
      id: true,
      gpuTier: true,
      gpuCount: true,
      durationDays: true,
      workloadType: true,
      tier: true,
      status: true,
      txConfirmed: true,
      txHash: true,
      paymentSource: true,
      eligibilityFlags: true,
      adminNote: true,
      requiredRegion: true,
      preferredOperatorId: true,
      allocatedNodeIds: true,
      requestedAt: true,
      createdAt: true,
      activatedAt: true,
      user: { select: { id: true, email: true } },
    },
  })

  if (!request) {
    console.error(`No ComputeRequest matches "${arg}" by txHash or id.`)
    process.exit(1)
  }

  const ageSeconds = Math.floor((Date.now() - request.createdAt.getTime()) / 1000)
  const ageMinutes = Math.floor(ageSeconds / 60)

  console.log('=== ComputeRequest state ===')
  console.log(`id              : ${request.id}`)
  console.log(`user            : ${request.user?.email ?? request.user?.id ?? 'unknown'}`)
  console.log(`gpuTier         : ${request.gpuTier}`)
  console.log(`gpuCount        : ${request.gpuCount}`)
  console.log(`workloadType    : ${request.workloadType}`)
  console.log(`tier (pricing)  : ${request.tier}`)
  console.log(`status          : ${request.status}`)
  console.log(`txConfirmed     : ${request.txConfirmed}`)
  console.log(`txHash          : ${request.txHash ?? 'null'}`)
  console.log(`paymentSource   : ${request.paymentSource}`)
  console.log(`eligibilityFlags: ${JSON.stringify(request.eligibilityFlags ?? [])}`)
  console.log(`adminNote       : ${request.adminNote ?? 'null'}`)
  console.log(`requiredRegion  : ${request.requiredRegion ?? 'null (any)'}`)
  console.log(`preferredOperatorId: ${request.preferredOperatorId ?? 'null'}`)
  console.log(`allocatedNodeIds: ${JSON.stringify(request.allocatedNodeIds ?? [])}`)
  console.log(`requestedAt     : ${request.requestedAt.toISOString()}`)
  console.log(`activatedAt     : ${request.activatedAt?.toISOString() ?? 'null'}`)
  console.log(`age             : ${ageMinutes}m ${ageSeconds % 60}s`)
  console.log('')

  console.log('=== Diagnosis ===')
  if (!request.txConfirmed && request.status === 'PENDING') {
    console.log('❌ Allocator will NOT pick this up. txConfirmed is false.')
    console.log('   Fix: pnpm --filter @a2e/api c2:confirm-tx ' + (request.txHash ?? request.id))
  } else if (request.status === 'WAITLISTED') {
    console.log('⚠️  Request is WAITLISTED. Eligibility rules rejected it.')
    console.log('   See eligibilityFlags + adminNote above for the reason.')
  } else if (request.status === 'PENDING' && request.txConfirmed) {
    const flags = (request.eligibilityFlags ?? []) as string[]
    if (flags.includes('WAITING_ON_CAPACITY')) {
      console.log('⚠️  Allocator ran but no matching idle ONLINE node was free for')
      console.log(`   tier=${request.gpuTier}. Check that your seeded test node is`)
      console.log('   still ONLINE, assignedComputeRequestId=null, and heartbeat-fresh.')
    } else if (flags.includes('NO_REGION_CAPACITY')) {
      console.log(`⚠️  No nodes ONLINE in requiredRegion=${request.requiredRegion}.`)
    } else {
      console.log('🟡 PENDING + txConfirmed=true, no eligibility flag set.')
      console.log('   The allocator may not have ticked yet. Wait ~10s and re-run this.')
    }
  } else if (request.status === 'ALLOCATED' || request.status === 'ACTIVE') {
    console.log('✅ Request is live.')
    console.log('   Nodes:', request.allocatedNodeIds)
  } else {
    console.log(`Status ${request.status} — nothing for the allocator to do here.`)
  }

  // Surface what nodes the allocator WOULD consider for this request right now.
  console.log('')
  console.log('=== Eligible nodes available right now ===')

  const HEARTBEAT_FRESH_MS = 2 * 60 * 1000
  const heartbeatFloor = new Date(Date.now() - HEARTBEAT_FRESH_MS)
  const eligibleNodes = await prisma.node.findMany({
    where: {
      gpuTier: request.gpuTier,
      status: 'ONLINE',
      currentJobId: null,
      assignedComputeRequestId: null,
      pendingDeletion: false,
      lastHeartbeat: { gte: heartbeatFloor },
      ...(request.requiredRegion ? { region: request.requiredRegion } : {}),
    },
    select: {
      id: true,
      gpuTier: true,
      region: true,
      isResidential: true,
      lastHeartbeat: true,
      agentVersion: true,
    },
    take: 10,
  })

  if (eligibleNodes.length === 0) {
    console.log(`No nodes match tier=${request.gpuTier}, status=ONLINE, idle, heartbeat<2min,`)
    if (request.requiredRegion) console.log(`         region=${request.requiredRegion}`)
    console.log('Confirm your seed node still satisfies all of those.')
  } else {
    for (const n of eligibleNodes) {
      const hbAge = Math.floor((Date.now() - n.lastHeartbeat.getTime()) / 1000)
      console.log(`  ${n.id}  tier=${n.gpuTier}  region=${n.region ?? 'null'}  residential=${n.isResidential}  hb=${hbAge}s ago  agent=${n.agentVersion ?? 'null'}`)
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
