/**
 * Seed deterministic test fixtures so the E2E test plan can exercise
 * every code path without manual setup. Idempotent: re-running upserts
 * by stable IDs / unique keys.
 *
 * Targets:
 *   - noderunner@tokenos.ai      (NODE_RUNNER role)
 *   - buyer@tokenos.ai           (COMPUTE_BUYER role)
 *   - buyer2@tokenos.ai          (extra buyer for admin queue tests)
 *
 * Run:   pnpm --filter @a2e/api seed:test
 *
 * Production guard: refuses to run unless ALLOW_PROD_SEED=1.
 */
import { prisma, Prisma } from '@a2e/database'
import bcrypt from 'bcryptjs'

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const dbUrl = process.env.DATABASE_URL ?? ''
if (!dbUrl) {
  console.error('DATABASE_URL is not set. Refusing to seed.')
  process.exit(1)
}
const looksProd =
  /a2e\.byredstone\.com|prod|production/i.test(dbUrl) ||
  /\.byredstone\.com/i.test(dbUrl) ||
  process.env.NODE_ENV === 'production'
if (looksProd && process.env.ALLOW_PROD_SEED !== '1') {
  console.error(
    `DATABASE_URL appears to point at a production-like host:\n  ${dbUrl}\n` +
      `Set ALLOW_PROD_SEED=1 to override.`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NR_EMAIL = 'noderunner@tokenos.ai'
const NR_PASSWORD = 'NodeRunner2026'
const NR_WALLET = 'SEEDsoLNRwallet1111111111111111111111111111'

const BUYER1_EMAIL = 'buyer@tokenos.ai'
const BUYER1_PASSWORD = 'Buyer2026!!'

const BUYER2_EMAIL = 'buyer2@tokenos.ai'
const BUYER2_PASSWORD = 'Buyer2026!!'

const NODE_COUNT = 25
const EARNINGS_DAYS = 30

const GPU_TIERS = ['H100', 'H200', 'B200', 'B300', 'GB300'] as const
const MARKETS = ['INTERNAL', 'AKASH', 'IONET', 'VASTAI'] as const

// Status distribution drives both initial seed and the keep-alive loop, which
// needs to know which seed-node-* IDs the node-health watcher will demote so it
// can keep their lastHeartbeat fresh.
type LiveStatus = 'ONLINE' | 'DEGRADED'
type SeededStatus = LiveStatus | 'OFFLINE' | 'PAUSED' | 'MAINTENANCE'
const NODE_DISTRIBUTION: Array<{
  status: SeededStatus
  count: number
  pendingDeletion?: boolean
}> = [
  { status: 'ONLINE', count: 8 },
  { status: 'OFFLINE', count: 5 },
  { status: 'PAUSED', count: 4 },
  { status: 'DEGRADED', count: 3 },
  { status: 'MAINTENANCE', count: 3 },
  { status: 'ONLINE', count: 1, pendingDeletion: true },
  { status: 'OFFLINE', count: 1, pendingDeletion: true },
]

const LIVE_NODE_INTENT: Array<{ id: string; status: LiveStatus }> = (() => {
  const out: Array<{ id: string; status: LiveStatus }> = []
  let i = 0
  for (const slot of NODE_DISTRIBUTION) {
    for (let j = 0; j < slot.count; j++) {
      i++
      if (slot.status === 'ONLINE' || slot.status === 'DEGRADED') {
        out.push({
          id: `seed-node-${String(i).padStart(3, '0')}`,
          status: slot.status,
        })
      }
    }
  }
  return out
})()

// Hourly yields per tier (matches the project rate sheet)
const HOURLY_RATE: Record<(typeof GPU_TIERS)[number], number> = {
  H100: 5.84,
  H200: 7.49,
  B200: 13.38,
  B300: 17.99,
  GB300: 20.81,
}

// Deterministic pseudo-random so re-runs produce the same numbers
function rand(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}
const rnd = rand(2026)
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)]

const today = new Date()
today.setUTCHours(0, 0, 0, 0)
function daysAgo(n: number): Date {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function ensureUser(
  email: string,
  password: string,
  role: 'NODE_RUNNER' | 'COMPUTE_BUYER' | 'ADMIN',
) {
  const passwordHash = await bcrypt.hash(password, 12)
  // Reset password on every run so the test-credentials doc stays authoritative;
  // re-running the seed is also a "reset test passwords" tool.
  return prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role, emailVerified: true },
    update: { passwordHash, role, emailVerified: true },
  })
}

// ---------------------------------------------------------------------------
// Node runner + nodes
// ---------------------------------------------------------------------------

async function seedNodeRunnerWithNodes() {
  const user = await ensureUser(NR_EMAIL, NR_PASSWORD, 'NODE_RUNNER')

  // NodeRunner has a 1-1 relation to User via unique userId. If one already
  // exists for this user (real registration on a deployed env), reuse it
  // rather than creating a second.
  let nodeRunner = await prisma.nodeRunner.findUnique({ where: { userId: user.id } })
  if (!nodeRunner) {
    nodeRunner = await prisma.nodeRunner.upsert({
      where: { walletAddress: NR_WALLET },
      create: {
        id: 'seed-noderunner-1',
        name: 'Seed Test Runner',
        email: NR_EMAIL,
        walletAddress: NR_WALLET,
        userId: user.id,
        payoutThreshold: 10,
        payoutFrequency: 'WEEKLY',
        payoutDayOfWeek: 1,
      },
      update: { userId: user.id, email: NR_EMAIL },
    })
  } else if (!nodeRunner.email) {
    nodeRunner = await prisma.nodeRunner.update({
      where: { id: nodeRunner.id },
      data: { email: NR_EMAIL },
    })
  }

  const nodes: Array<{ id: string; status: string; gpuTier: string }> = []
  let i = 0
  for (const slot of NODE_DISTRIBUTION) {
    for (let j = 0; j < slot.count; j++) {
      i++
      const id = `seed-node-${String(i).padStart(3, '0')}`
      const gpuTier = GPU_TIERS[i % GPU_TIERS.length]
      const isLive = slot.status === 'ONLINE' || slot.status === 'DEGRADED'
      const node = await prisma.node.upsert({
        where: { id },
        create: {
          id,
          walletAddress: `SEEDnodeWallet${String(i).padStart(3, '0')}xxxxxxxxxxxxxxxxxxxxxxxx`,
          gpuTier: gpuTier as Prisma.NodeCreateInput['gpuTier'],
          nodeType: i % 3 === 0 ? 'BYOG' : 'PROVISIONED',
          status: slot.status as Prisma.NodeCreateInput['status'],
          region: pick(['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1']),
          nodeRunnerId: nodeRunner.id,
          apiKey: `seed-apikey-node-${String(i).padStart(3, '0')}`,
          pendingDeletion: slot.pendingDeletion ?? false,
          agentVersion: '1.4.2',
          lastHeartbeat: isLive ? new Date(Date.now() - 30_000) : daysAgo(2),
          missedBeats: isLive ? 0 : Math.floor(rnd() * 5) + 1,
        },
        update: {
          status: slot.status as Prisma.NodeUpdateInput['status'],
          pendingDeletion: slot.pendingDeletion ?? false,
          lastHeartbeat: isLive ? new Date(Date.now() - 30_000) : daysAgo(2),
        },
      })
      nodes.push({ id: node.id, status: node.status, gpuTier: node.gpuTier })

      // A few recent heartbeats so the heartbeat history view has data.
      // Delete prior seeded heartbeats first so re-runs don't accumulate.
      if (isLive) {
        await prisma.heartbeat.deleteMany({ where: { nodeId: node.id } })
        for (let h = 0; h < 5; h++) {
          await prisma.heartbeat.create({
            data: {
              nodeId: node.id,
              gpuUtilization: 30 + rnd() * 60,
              gpuTemperature: 55 + rnd() * 20,
              gpuMemoryUsed: 20 + rnd() * 30,
              gpuMemoryTotal: 80,
              timestamp: new Date(Date.now() - h * 60_000),
            },
          })
        }
      }
    }
  }

  if (i !== NODE_COUNT) {
    console.warn(`Expected ${NODE_COUNT} nodes, created ${i}`)
  }
  return { user, nodeRunner, nodes }
}

// ---------------------------------------------------------------------------
// Investments + provision jobs (admin deployment queue)
// ---------------------------------------------------------------------------

async function seedInvestmentsAndProvisionJobs(nodeRunnerId: string) {
  const investments = [
    {
      id: 'seed-inv-pending',
      status: 'PENDING' as const,
      gpuTier: 'H100' as const,
      amount: 2500,
      txHash: 'test_tx_pending',
      txConfirmed: false,
    },
    {
      id: 'seed-inv-deployment-requested',
      status: 'DEPLOYMENT_REQUESTED' as const,
      gpuTier: 'H200' as const,
      amount: 3125,
      txHash: 'test_tx_deployreq',
      txConfirmed: true,
      confirmedAt: daysAgo(3),
      deploymentRequestedAt: daysAgo(2),
      deploymentNote: 'Please provision in us-east region',
    },
    {
      id: 'seed-inv-deploying',
      status: 'DEPLOYING' as const,
      gpuTier: 'B200' as const,
      amount: 5250,
      txHash: 'test_tx_deploying',
      txConfirmed: true,
      confirmedAt: daysAgo(1),
      deploymentRequestedAt: daysAgo(1),
    },
    {
      id: 'seed-inv-provisioned',
      status: 'PROVISIONED' as const,
      gpuTier: 'H100' as const,
      amount: 2500,
      txHash: 'test_tx_provisioned',
      txConfirmed: true,
      confirmedAt: daysAgo(15),
      deploymentRequestedAt: daysAgo(15),
      provisionedAt: daysAgo(14),
    },
    {
      id: 'seed-inv-cancelled',
      status: 'CANCELLED' as const,
      gpuTier: 'H100' as const,
      amount: 2500,
      txHash: null,
      txConfirmed: false,
    },
  ]

  for (const inv of investments) {
    await prisma.investment.upsert({
      where: { id: inv.id },
      create: {
        ...inv,
        nodeRunnerId,
        currency: 'USD',
        nodeCount: 1,
      } as Prisma.InvestmentUncheckedCreateInput,
      update: {
        status: inv.status,
        txConfirmed: inv.txConfirmed,
      },
    })
  }

  // FAILED ProvisionJob — for M5-DEPL-05
  await prisma.provisionJob.upsert({
    where: { id: 'seed-pjob-failed' },
    create: {
      id: 'seed-pjob-failed',
      status: 'FAILED',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      gpuTier: 'H100',
      nodeName: 'Failed Test Provision',
      region: 'us-east-1',
      currentStep: 2,
      totalSteps: 7,
      currentAction: 'connecting',
      logs: [
        { ts: daysAgo(2).toISOString(), level: 'info', msg: 'Connecting to 1.2.3.4:22' },
        { ts: daysAgo(2).toISOString(), level: 'error', msg: 'SSH connect failed: timeout after 30s' },
      ],
      error: 'SSH connection failed: connect ETIMEDOUT 1.2.3.4:22',
      startedAt: daysAgo(2),
      completedAt: daysAgo(2),
    },
    update: { status: 'FAILED', error: 'SSH connection failed: connect ETIMEDOUT 1.2.3.4:22' },
  })
}

// ---------------------------------------------------------------------------
// Earnings + jobs
// ---------------------------------------------------------------------------

async function seedEarningsAndJobs(
  nodes: Array<{ id: string; status: string; gpuTier: string }>,
) {
  const earningNodes = nodes.filter((n) => n.status === 'ONLINE' || n.status === 'DEGRADED')

  for (const node of earningNodes) {
    const tierRate = HOURLY_RATE[node.gpuTier as keyof typeof HOURLY_RATE] ?? 5
    for (let d = 0; d < EARNINGS_DAYS; d++) {
      const date = daysAgo(d)
      // 1-3 markets per day, weighted toward INTERNAL
      const dayMarkets = MARKETS.filter(() => rnd() > 0.5)
      const markets = dayMarkets.length === 0 ? ['INTERNAL'] : dayMarkets
      for (const market of markets) {
        const hours = market === 'INTERNAL' ? 8 + rnd() * 12 : 2 + rnd() * 8
        const earnings = Number((hours * tierRate * (market === 'INTERNAL' ? 1 : 0.7)).toFixed(2))
        await prisma.earning.upsert({
          where: { nodeId_date_market: { nodeId: node.id, date, market: market as 'INTERNAL' } },
          create: {
            nodeId: node.id,
            date,
            market: market as Prisma.EarningCreateInput['market'],
            gpuSeconds: Math.floor(hours * 3600),
            earnings,
            jobCount: Math.floor(hours / 2) + 1,
          },
          update: { earnings, gpuSeconds: Math.floor(hours * 3600) },
        })
      }
    }

    // A handful of completed Job rows for the Jobs list view
    for (let j = 0; j < 4; j++) {
      const jobId = `seed-job-${node.id}-${j}`
      const market = pick(MARKETS) as Prisma.JobCreateInput['market']
      const startedAt = new Date(Date.now() - (j + 1) * 4 * 3600_000)
      const duration = 1800 + Math.floor(rnd() * 5400)
      const earnings = Number(((duration / 3600) * tierRate).toFixed(2))
      await prisma.job.upsert({
        where: { id: jobId },
        create: {
          id: jobId,
          deploymentId: `seed-dep-${node.id}-${j}`,
          nodeId: node.id,
          market,
          ratePerHour: tierRate,
          gpuTier: node.gpuTier as Prisma.JobCreateInput['gpuTier'],
          status: j === 0 ? 'RUNNING' : 'COMPLETED',
          source: 'INTERNAL',
          requestedAt: startedAt,
          startedAt,
          completedAt: j === 0 ? null : new Date(startedAt.getTime() + duration * 1000),
          durationSeconds: j === 0 ? null : duration,
          earnings: j === 0 ? null : earnings,
          cost: j === 0 ? null : earnings * 0.4,
          profit: j === 0 ? null : earnings * 0.6,
        },
        update: {},
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Settlements + payments (= "payouts")
// ---------------------------------------------------------------------------

async function seedSettlementsAndPayments(
  nodes: Array<{ id: string; status: string }>,
) {
  const eligible = nodes.filter((n) => n.status === 'ONLINE').slice(0, 2)
  let i = 0
  for (const node of eligible) {
    i++
    const settlementId = `seed-settlement-${i}`
    const periodStart = daysAgo(i === 1 ? 14 : 7)
    const periodEnd = daysAgo(i === 1 ? 7 : 0)
    const amount = 80 + i * 25
    await prisma.settlement.upsert({
      where: { id: settlementId },
      create: {
        id: settlementId,
        nodeId: node.id,
        walletAddress: NR_WALLET,
        amount,
        currency: 'USD',
        status: 'COMPLETED',
        periodStart,
        periodEnd,
        jobCount: 12 + i,
        txHash: `DEV_settlement_${i}_${Date.now().toString(36)}`,
        txConfirmed: true,
        processedAt: periodEnd,
      },
      update: { status: 'COMPLETED', amount },
    })

    const paymentId = `seed-payment-${i}`
    await prisma.payment.upsert({
      where: { id: paymentId },
      create: {
        id: paymentId,
        settlementId,
        amount,
        currency: 'USDC',
        recipientAddress: NR_WALLET,
        status: 'CONFIRMED',
        txHash: `DEV_payment_${i}_${Date.now().toString(36)}`,
        txConfirmed: true,
        confirmations: 32,
        isDevMode: true,
        processedAt: periodEnd,
        confirmedAt: periodEnd,
      },
      update: { status: 'CONFIRMED' },
    })
  }
}

// ---------------------------------------------------------------------------
// Withdrawal requests
// ---------------------------------------------------------------------------

async function seedWithdrawals(nodeRunnerId: string) {
  const items: Array<{
    id: string
    status: 'PENDING' | 'COMPLETED' | 'REJECTED'
    amount: number
    txHash?: string
    adminNote?: string
    requestedAt: Date
    processedAt?: Date
    rejectedAt?: Date
  }> = [
    {
      id: 'seed-wd-pending',
      status: 'PENDING',
      amount: 50,
      requestedAt: daysAgo(1),
    },
    {
      id: 'seed-wd-completed',
      status: 'COMPLETED',
      amount: 75,
      txHash: `DEV_withdrawal_1_${Date.now().toString(36)}`,
      requestedAt: daysAgo(10),
      processedAt: daysAgo(8),
    },
    {
      id: 'seed-wd-rejected',
      status: 'REJECTED',
      amount: 40,
      adminNote: 'Wallet address mismatch — please verify.',
      requestedAt: daysAgo(20),
      rejectedAt: daysAgo(19),
    },
  ]

  for (const w of items) {
    await prisma.withdrawalRequest.upsert({
      where: { id: w.id },
      create: {
        id: w.id,
        nodeRunnerId,
        amount: w.amount,
        walletAddress: NR_WALLET,
        status: w.status,
        adminNote: w.adminNote,
        txHash: w.txHash,
        requestedAt: w.requestedAt,
        processedAt: w.processedAt,
        rejectedAt: w.rejectedAt,
      },
      update: { status: w.status, txHash: w.txHash, adminNote: w.adminNote },
    })
  }
}

// ---------------------------------------------------------------------------
// Compute requests (buyer queue)
// ---------------------------------------------------------------------------

async function seedComputeRequests() {
  const buyer1 = await ensureUser(BUYER1_EMAIL, BUYER1_PASSWORD, 'COMPUTE_BUYER')
  const buyer2 = await ensureUser(BUYER2_EMAIL, BUYER2_PASSWORD, 'COMPUTE_BUYER')

  const requests = [
    {
      id: 'seed-cr-buyer1-pending',
      userId: buyer1.id,
      gpuTier: 'H100' as const,
      gpuCount: 2,
      durationDays: 30,
      ratePerDay: 140.15,
      status: 'PENDING' as const,
      purpose: 'LLM fine-tuning',
    },
    {
      id: 'seed-cr-buyer1-active',
      userId: buyer1.id,
      gpuTier: 'H200' as const,
      gpuCount: 1,
      durationDays: 14,
      ratePerDay: 179.85,
      status: 'ACTIVE' as const,
      purpose: 'Inference workload',
      sshHost: '10.10.10.199',
      sshPort: 22,
      sshUsername: 'compute',
      sshPassword: 'TestNode2026',
      activatedAt: daysAgo(3),
    },
    {
      id: 'seed-cr-buyer1-completed',
      userId: buyer1.id,
      gpuTier: 'H100' as const,
      gpuCount: 1,
      durationDays: 7,
      ratePerDay: 140.15,
      status: 'COMPLETED' as const,
      completedAt: daysAgo(5),
    },
    {
      id: 'seed-cr-buyer2-pending-1',
      userId: buyer2.id,
      gpuTier: 'B200' as const,
      gpuCount: 1,
      durationDays: 30,
      ratePerDay: 321.10,
      status: 'PENDING' as const,
      purpose: 'Diffusion model training',
    },
    {
      id: 'seed-cr-buyer2-pending-2',
      userId: buyer2.id,
      gpuTier: 'GB300' as const,
      gpuCount: 4,
      durationDays: 60,
      ratePerDay: 499.35,
      status: 'PENDING' as const,
      purpose: 'Frontier model pretraining',
    },
  ]

  for (const r of requests) {
    const totalCost = r.gpuCount * r.ratePerDay * r.durationDays
    await prisma.computeRequest.upsert({
      where: { id: r.id },
      create: {
        ...r,
        totalCost,
        currency: 'USD',
        txHash: `test_${r.id}`,
        txConfirmed: true,
      } as Prisma.ComputeRequestUncheckedCreateInput,
      update: { status: r.status, totalCost },
    })
  }
}

// ---------------------------------------------------------------------------
// External deployments (M7)
// ---------------------------------------------------------------------------

async function seedExternalDeployments(
  nodes: Array<{ id: string; status: string; gpuTier: string }>,
) {
  const candidates = nodes.filter((n) => n.status === 'ONLINE').slice(0, 3)
  if (candidates.length < 3) return

  const fixtures = [
    {
      id: 'seed-ext-akash-active',
      market: 'AKASH' as const,
      status: 'ACTIVE' as const,
      ageMin: 90,
    },
    {
      id: 'seed-ext-ionet-pending',
      market: 'IONET' as const,
      status: 'PENDING' as const,
      ageMin: 1,
    },
    {
      id: 'seed-ext-vastai-terminating',
      market: 'VASTAI' as const,
      status: 'TERMINATING' as const,
      ageMin: 200,
    },
  ]

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i]!
    const node = candidates[i]!
    const tierRate = HOURLY_RATE[node.gpuTier as keyof typeof HOURLY_RATE] ?? 5
    const externalRate = Number((tierRate * 0.7).toFixed(2))
    const hoursActive = f.ageMin / 60
    await prisma.externalDeployment.upsert({
      where: { id: f.id },
      create: {
        id: f.id,
        nodeId: node.id,
        market: f.market,
        externalId: `${f.market.toLowerCase()}-deploy-${f.id}`,
        status: f.status,
        ratePerHour: externalRate,
        costAccumulated: Number((hoursActive * externalRate * 0.3).toFixed(2)),
        earningsAccumulated: Number((hoursActive * externalRate).toFixed(2)),
        createdAt: new Date(Date.now() - f.ageMin * 60_000),
        lastCheckedAt: new Date(Date.now() - 30_000),
      },
      update: {
        status: f.status,
        earningsAccumulated: Number((hoursActive * externalRate).toFixed(2)),
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Notifications (so the activity feed has rows)
// ---------------------------------------------------------------------------

async function seedNotifications(userId: string) {
  await prisma.notification.deleteMany({
    where: { userId, message: { contains: '[seed]' } },
  })
  const items: Array<{
    type: Prisma.NotificationCreateInput['type']
    title: string
    message: string
  }> = [
    {
      type: 'PAYOUT_SENT',
      title: 'Payout sent',
      message: '[seed] $100 USDC payout sent (DEV_payment_1).',
    },
    {
      type: 'JOB_COMPLETED',
      title: 'Job completed',
      message: '[seed] Job seed-job-001 completed on H100.',
    },
    {
      type: 'NODE_OFFLINE',
      title: 'Node offline',
      message: '[seed] Node seed-node-009 went offline.',
    },
    {
      type: 'WITHDRAWAL_COMPLETED',
      title: 'Withdrawal completed',
      message: '[seed] Withdrawal of $75 completed.',
    },
    {
      type: 'INVESTMENT_PROVISIONED',
      title: 'Investment provisioned',
      message: '[seed] Your H100 investment was provisioned.',
    },
  ]
  for (const n of items) {
    await prisma.notification.create({ data: { userId, ...n } })
  }
}

// ---------------------------------------------------------------------------
// Keep-alive loop
// ---------------------------------------------------------------------------

const KEEP_ALIVE_INTERVAL_MS = 30_000

async function keepAliveTick() {
  const now = new Date()
  for (const live of LIVE_NODE_INTENT) {
    await prisma.node.update({
      where: { id: live.id },
      data: {
        status: live.status,
        lastHeartbeat: now,
        missedBeats: 0,
      },
    })
    await prisma.heartbeat.create({
      data: {
        nodeId: live.id,
        gpuUtilization: 30 + rnd() * 60,
        gpuTemperature: 55 + rnd() * 20,
        gpuMemoryUsed: 20 + rnd() * 30,
        gpuMemoryTotal: 80,
        timestamp: now,
      },
    })
  }
}

async function runKeepAliveLoop() {
  console.log(
    `\nKeep-alive started: bumping ${LIVE_NODE_INTENT.length} live seed nodes ` +
      `every ${KEEP_ALIVE_INTERVAL_MS / 1000}s. Ctrl-C to stop.`,
  )

  let stop = false
  process.on('SIGINT', () => {
    console.log('\nKeep-alive: SIGINT received, exiting after this tick.')
    stop = true
  })
  process.on('SIGTERM', () => {
    console.log('\nKeep-alive: SIGTERM received, exiting after this tick.')
    stop = true
  })

  // Periodically prune accumulated heartbeats so the table doesn't grow
  // unbounded over a long-running keep-alive session.
  let tickCount = 0
  while (!stop) {
    try {
      await keepAliveTick()
      tickCount++
      if (tickCount % 60 === 0) {
        const cutoff = new Date(Date.now() - 60 * 60_000) // keep last hour
        await prisma.heartbeat.deleteMany({
          where: {
            nodeId: { in: LIVE_NODE_INTENT.map((l) => l.id) },
            timestamp: { lt: cutoff },
          },
        })
      }
      const stamp = new Date().toISOString()
      process.stdout.write(`[${stamp}] keep-alive tick #${tickCount}\n`)
    } catch (err) {
      console.error('Keep-alive tick failed:', err)
    }
    await new Promise((resolve) => setTimeout(resolve, KEEP_ALIVE_INTERVAL_MS))
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seed() {
  console.log('Seeding test fixtures...')
  console.log(`Target DB: ${dbUrl.replace(/\/\/[^@]*@/, '//***@')}`)

  const { user, nodeRunner, nodes } = await seedNodeRunnerWithNodes()
  console.log(`✓ Node runner ${nodeRunner.email} + ${nodes.length} nodes`)

  await seedInvestmentsAndProvisionJobs(nodeRunner.id)
  console.log('✓ Investments + 1 FAILED provision job')

  await seedEarningsAndJobs(nodes)
  console.log(`✓ Earnings (${EARNINGS_DAYS} days) + jobs`)

  await seedSettlementsAndPayments(nodes)
  console.log('✓ Settlements + payments (payouts)')

  await seedWithdrawals(nodeRunner.id)
  console.log('✓ Withdrawal requests (PENDING + COMPLETED + REJECTED)')

  await seedComputeRequests()
  console.log('✓ Compute requests for both buyers')

  await seedExternalDeployments(nodes)
  console.log('✓ External deployments (AKASH ACTIVE, IONET PENDING, VASTAI TERMINATING)')

  await seedNotifications(user.id)
  console.log('✓ Notifications for activity feed')

  console.log('\nDone. Re-run any time — script is idempotent.')
}

async function main() {
  const args = process.argv.slice(2)
  const keepAliveOnly = args.includes('--keep-alive-only')
  const keepAlive = keepAliveOnly || args.includes('--keep-alive')

  if (!keepAliveOnly) {
    await seed()
  } else {
    console.log('Skipping seed (keep-alive-only mode).')
  }

  if (keepAlive) {
    await runKeepAliveLoop()
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
