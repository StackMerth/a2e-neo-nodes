// External Market Admin — Handler Bodies (M7 F5.1)
//
// Handler bodies pulled out of `external.ts` into plain async functions so the
// unit tests can drive them without spinning a Fastify instance. Each exported
// function takes explicit dependencies (prisma, registry) and a typed input
// shape, and returns either a success payload or a `{ status, error }` tuple
// that the route wrapper maps onto `reply.code(...).send(...)`.

import type {
  PrismaClient,
  ExternalDeployment,
  ExternalDeploymentStatus,
  OverflowConfig,
  Market,
} from '@a2e/database'
import type { GpuTier } from '@a2e/shared'
import type {
  AdapterRegistry,
  MarketRates,
  MarketRateInfo,
  RateProvider,
} from '@a2e/core'
import { isSimulationMode } from '@a2e/core'
import {
  getOrCreateOverflowConfig,
  selectBestMarket,
} from '../services/overflow/engine'
import {
  listNodeExternally,
  delistNode,
} from '../services/overflow/listing-manager'
import { getExternalJobsForDeployment } from '../services/overflow/execution-bridge'

export type ExternalMarket = 'AKASH' | 'IONET' | 'VASTAI'

export const EXTERNAL_MARKETS: ReadonlyArray<ExternalMarket> = ['AKASH', 'IONET', 'VASTAI']

// Deployment statuses returned by default on the list endpoint — anything
// still alive in the external-deployment state machine.
export const ACTIVE_DEPLOYMENT_STATUSES: ReadonlyArray<ExternalDeploymentStatus> = [
  'PENDING',
  'ACTIVE',
  'TERMINATING',
]

export interface HandlerError {
  status: number
  error: string
  message?: string
  extra?: Record<string, unknown>
}

export type HandlerResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: HandlerError }

function err(status: number, error: string, message?: string, extra?: Record<string, unknown>): HandlerResult<never> {
  const body: HandlerError = { status, error }
  if (message !== undefined) body.message = message
  if (extra) body.extra = extra
  return { ok: false, status, body }
}

function ok<T>(status: number, body: T): HandlerResult<T> {
  return { ok: true, status, body }
}

/**
 * Build a RateProvider backed by the `MarketRate` table. Internal rates are
 * intentionally zero — the overflow engine only inspects external markets.
 */
export function createDbRateProvider(prisma: PrismaClient): RateProvider {
  return {
    async getRates(gpuTier: GpuTier): Promise<MarketRates> {
      const now = new Date()
      const rows = await prisma.marketRate.findMany({
        where: { gpuTier, market: { in: ['AKASH', 'IONET', 'VASTAI'] } },
      })

      const empty: MarketRateInfo = {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: now,
      }
      const internal: MarketRateInfo = { ...empty, available: false }

      const byMarket: Record<ExternalMarket, MarketRateInfo> = {
        AKASH: { ...empty },
        IONET: { ...empty },
        VASTAI: { ...empty },
      }

      for (const row of rows) {
        const key = row.market as ExternalMarket
        if (!EXTERNAL_MARKETS.includes(key)) continue
        byMarket[key] = {
          ratePerHour: row.ratePerHour,
          ratePerDay: row.ratePerDay,
          available: row.available,
          fetchedAt: row.fetchedAt,
        }
      }

      return {
        internal,
        akash: byMarket.AKASH,
        ionet: byMarket.IONET,
        vastai: byMarket.VASTAI,
      }
    },
    async refreshRates(): Promise<void> {
      // No-op — the MarketRate table is kept fresh by the rate-fetcher worker.
    },
  }
}

// ------------------------------------------------------------------
// GET /v1/external/status
// ------------------------------------------------------------------

export interface StatusMarketEntry {
  market: ExternalMarket
  enabled: boolean
  healthy: boolean
  autoDisabled: boolean
  failureCount: number
  lastSuccess: string | null
  lastFailure: string | null
  lastError: string | null
  latestRates: Record<string, { ratePerHour: number; available: boolean } | null>
}

export interface StatusResponse {
  simulationMode: boolean
  overflow: {
    enabled: boolean
    idleThresholdMinutes: number
    demandThresholdPercent: number
    marginProtectionPercent: number
    gracePeriodSeconds: number
  }
  markets: StatusMarketEntry[]
}

const GPU_TIERS: ReadonlyArray<GpuTier> = ['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER']

export async function getExternalStatus(
  prisma: PrismaClient,
  registry: AdapterRegistry,
): Promise<HandlerResult<StatusResponse>> {
  const config = await getOrCreateOverflowConfig(prisma)
  const healthList = registry.getAllHealth()
  const healthByMarket = new Map(healthList.map((h) => [h.market, h]))

  const rates = await prisma.marketRate.findMany({
    where: { market: { in: ['AKASH', 'IONET', 'VASTAI'] } },
  })

  const ratesByMarket: Record<ExternalMarket, Map<string, { ratePerHour: number; available: boolean }>> = {
    AKASH: new Map(),
    IONET: new Map(),
    VASTAI: new Map(),
  }
  for (const r of rates) {
    const mkt = r.market as ExternalMarket
    if (!EXTERNAL_MARKETS.includes(mkt)) continue
    ratesByMarket[mkt].set(r.gpuTier, {
      ratePerHour: r.ratePerHour,
      available: r.available,
    })
  }

  const markets: StatusMarketEntry[] = EXTERNAL_MARKETS.map((market) => {
    const adapter = registry.get(market)
    const health = healthByMarket.get(market)
    const latestRates: Record<string, { ratePerHour: number; available: boolean } | null> = {}
    for (const tier of GPU_TIERS) {
      latestRates[tier] = ratesByMarket[market].get(tier) ?? null
    }

    return {
      market,
      enabled: adapter?.isEnabled() ?? false,
      healthy: health?.healthy ?? false,
      autoDisabled: health?.autoDisabled ?? false,
      failureCount: health?.failureCount ?? 0,
      lastSuccess: health?.lastSuccess ? health.lastSuccess.toISOString() : null,
      lastFailure: health?.lastFailure ? health.lastFailure.toISOString() : null,
      lastError: health?.lastError ?? null,
      latestRates,
    }
  })

  return ok(200, {
    simulationMode: isSimulationMode(),
    overflow: {
      enabled: config.enabled,
      idleThresholdMinutes: config.idleThresholdMinutes,
      demandThresholdPercent: config.demandThresholdPercent,
      marginProtectionPercent: config.marginProtectionPercent,
      gracePeriodSeconds: config.gracePeriodSeconds,
    },
    markets,
  })
}

// ------------------------------------------------------------------
// GET /v1/external/deployments
// ------------------------------------------------------------------

export interface ListDeploymentsQuery {
  status?: string
}

export interface DeploymentWithNode extends ExternalDeployment {
  node: { id: string; gpuTier: GpuTier; walletAddress: string }
}

export interface ListDeploymentsResponse {
  deployments: DeploymentWithNode[]
  counts: Record<ExternalDeploymentStatus, number>
}

function parseStatusFilter(raw: string | undefined): ExternalDeploymentStatus[] {
  if (!raw) return [...ACTIVE_DEPLOYMENT_STATUSES]
  const parts = raw
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0)
  const allowed: ExternalDeploymentStatus[] = ['PENDING', 'ACTIVE', 'TERMINATING', 'TERMINATED', 'FAILED']
  return parts.filter((p): p is ExternalDeploymentStatus => allowed.includes(p as ExternalDeploymentStatus))
}

export async function listDeployments(
  prisma: PrismaClient,
  query: ListDeploymentsQuery,
): Promise<HandlerResult<ListDeploymentsResponse>> {
  const statuses = parseStatusFilter(query.status)
  const where = statuses.length > 0 ? { status: { in: statuses } } : {}

  const deployments = (await prisma.externalDeployment.findMany({
    where,
    include: {
      node: { select: { id: true, gpuTier: true, walletAddress: true } },
    },
    orderBy: { createdAt: 'desc' },
  })) as unknown as DeploymentWithNode[]

  const allStatuses: ExternalDeploymentStatus[] = ['PENDING', 'ACTIVE', 'TERMINATING', 'TERMINATED', 'FAILED']
  const counts = {} as Record<ExternalDeploymentStatus, number>
  for (const s of allStatuses) counts[s] = 0
  const groups = await prisma.externalDeployment.groupBy({
    by: ['status'],
    _count: { _all: true },
  })
  for (const row of groups as Array<{ status: ExternalDeploymentStatus; _count: { _all: number } }>) {
    counts[row.status] = row._count._all
  }

  return ok(200, { deployments, counts })
}

// ------------------------------------------------------------------
// GET /v1/external/deployments/:id
// ------------------------------------------------------------------

export interface DeploymentDetailResponse {
  deployment: DeploymentWithNode
  jobs: Awaited<ReturnType<typeof getExternalJobsForDeployment>>
}

export async function getDeploymentDetail(
  prisma: PrismaClient,
  id: string,
): Promise<HandlerResult<DeploymentDetailResponse>> {
  const deployment = (await prisma.externalDeployment.findUnique({
    where: { id },
    include: {
      node: { select: { id: true, gpuTier: true, walletAddress: true } },
    },
  })) as unknown as DeploymentWithNode | null

  if (!deployment) {
    return err(404, 'Not Found', `deployment ${id} not found`)
  }

  const jobs = await getExternalJobsForDeployment(prisma, id)
  return ok(200, { deployment, jobs })
}

// ------------------------------------------------------------------
// POST /v1/external/list/:nodeId
// ------------------------------------------------------------------

export interface ListNodeInput {
  nodeId: string
  market?: ExternalMarket
}

export interface ListNodeResponse {
  deploymentId: string
  externalId: string
  status: ExternalDeploymentStatus
  market: ExternalMarket
  ratePerHour: number
}

export async function adminListNode(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  input: ListNodeInput,
): Promise<HandlerResult<ListNodeResponse>> {
  const node = await prisma.node.findUnique({
    where: { id: input.nodeId },
    select: { id: true, gpuTier: true, customRatePerHour: true },
  })
  if (!node) {
    return err(404, 'Not Found', `node ${input.nodeId} not found`)
  }

  // Reject early if the node already has a live deployment.
  const existing = await prisma.externalDeployment.findFirst({
    where: {
      nodeId: input.nodeId,
      status: { in: [...ACTIVE_DEPLOYMENT_STATUSES] },
    },
    select: { id: true, status: true },
  })
  if (existing) {
    return err(
      409,
      'Conflict',
      'node already has an active external deployment',
      { deploymentId: existing.id, status: existing.status },
    )
  }

  let chosenMarket: ExternalMarket
  let ratePerHour: number

  if (input.market) {
    if (!registry.isAvailable(input.market)) {
      return err(
        400,
        'Bad Request',
        `market ${input.market} is not available`,
      )
    }
    // Pull the rate for this specific market from MarketRate.
    const row = await prisma.marketRate.findFirst({
      where: { market: input.market, gpuTier: node.gpuTier },
    })
    if (!row || !row.available || row.ratePerHour <= 0) {
      return err(
        400,
        'Bad Request',
        `no available rate for ${input.market} ${node.gpuTier}`,
      )
    }
    chosenMarket = input.market
    ratePerHour = row.ratePerHour
  } else {
    const config = await getOrCreateOverflowConfig(prisma)
    const rateProvider = createDbRateProvider(prisma)
    const best = await selectBestMarket(
      { config, registry, rateProvider },
      node.gpuTier,
      node.customRatePerHour,
    )
    if (!best.market) {
      return err(400, 'Bad Request', best.reason)
    }
    chosenMarket = best.market
    ratePerHour = best.ratePerHour
  }

  try {
    const result = await listNodeExternally(prisma, registry, {
      nodeId: input.nodeId,
      market: chosenMarket,
      ratePerHour,
    })
    return ok(201, {
      deploymentId: result.deploymentId,
      externalId: result.externalId,
      status: result.status,
      market: chosenMarket,
      ratePerHour,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already has an active external deployment')) {
      return err(409, 'Conflict', message)
    }
    if (message.includes('not available')) {
      return err(400, 'Bad Request', message)
    }
    if (message.includes('not found')) {
      return err(404, 'Not Found', message)
    }
    return err(500, 'Internal Error', message)
  }
}

// ------------------------------------------------------------------
// DELETE /v1/external/list/:nodeId
// ------------------------------------------------------------------

export interface DelistNodeInput {
  nodeId: string
  mode: 'safe' | 'force'
  reason?: string
}

export interface DelistNodeResponse {
  status: ExternalDeploymentStatus
  terminated: boolean
  deploymentId: string
}

export async function adminDelistNode(
  prisma: PrismaClient,
  registry: AdapterRegistry,
  input: DelistNodeInput,
): Promise<HandlerResult<DelistNodeResponse>> {
  const deployment = await prisma.externalDeployment.findFirst({
    where: {
      nodeId: input.nodeId,
      status: { in: [...ACTIVE_DEPLOYMENT_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (!deployment) {
    return err(
      404,
      'Not Found',
      `no active external deployment for node ${input.nodeId}`,
    )
  }

  const mode = input.mode === 'force' ? 'FORCE' : 'SAFE'
  const reason = input.reason ?? `manual admin ${mode.toLowerCase()} delist`

  // NOTE: terminationQueue is intentionally omitted — SAFE mode here only
  // flips the row to TERMINATING. Bootstrap wiring (F6.3) will later inject
  // the queue so SAFE delists schedule their own policy poll automatically.
  const result = await delistNode(prisma, registry, {
    deploymentId: deployment.id,
    mode,
    reason,
  })

  return ok(200, {
    status: result.status,
    terminated: result.terminated,
    deploymentId: deployment.id,
  })
}

// ------------------------------------------------------------------
// GET /v1/external/earnings
// ------------------------------------------------------------------

export interface EarningsQuery {
  from?: string
  to?: string
  nodeId?: string
  market?: ExternalMarket
}

export interface EarningsResponse {
  totalUsd: number
  byMarket: Record<ExternalMarket, number>
  byNode: Array<{ nodeId: string; walletAddress: string; totalUsd: number }>
  periodStart: string
  periodEnd: string
}

const DEFAULT_WINDOW_DAYS = 30

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d
}

export async function getExternalEarnings(
  prisma: PrismaClient,
  query: EarningsQuery,
): Promise<HandlerResult<EarningsResponse>> {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86400_000)
  defaultFrom.setUTCHours(0, 0, 0, 0)

  const from = parseDate(query.from) ?? defaultFrom
  const to = parseDate(query.to) ?? now

  if (query.from && parseDate(query.from) === null) {
    return err(400, 'Bad Request', `invalid 'from' date`)
  }
  if (query.to && parseDate(query.to) === null) {
    return err(400, 'Bad Request', `invalid 'to' date`)
  }
  if (from > to) {
    return err(400, 'Bad Request', `'from' must be <= 'to'`)
  }

  const marketFilter: Market[] = query.market
    ? [query.market as Market]
    : (['AKASH', 'IONET', 'VASTAI'] as Market[])

  const where: Record<string, unknown> = {
    market: { in: marketFilter },
    date: { gte: from, lte: to },
  }
  if (query.nodeId) where.nodeId = query.nodeId

  const rows = await prisma.earning.findMany({
    where,
    include: { node: { select: { walletAddress: true } } },
  })

  const byMarket: Record<ExternalMarket, number> = {
    AKASH: 0,
    IONET: 0,
    VASTAI: 0,
  }
  const byNodeMap = new Map<string, { nodeId: string; walletAddress: string; totalUsd: number }>()
  let totalUsd = 0

  for (const row of rows as Array<{
    nodeId: string
    earnings: number
    market: Market
    node: { walletAddress: string } | null
  }>) {
    const mkt = row.market as ExternalMarket
    if (EXTERNAL_MARKETS.includes(mkt)) {
      byMarket[mkt] += row.earnings
    }
    totalUsd += row.earnings

    const existing = byNodeMap.get(row.nodeId)
    if (existing) {
      existing.totalUsd += row.earnings
    } else {
      byNodeMap.set(row.nodeId, {
        nodeId: row.nodeId,
        walletAddress: row.node?.walletAddress ?? '',
        totalUsd: row.earnings,
      })
    }
  }

  const byNode = Array.from(byNodeMap.values()).sort((a, b) => b.totalUsd - a.totalUsd)

  return ok(200, {
    totalUsd,
    byMarket,
    byNode,
    periodStart: from.toISOString(),
    periodEnd: to.toISOString(),
  })
}

// ------------------------------------------------------------------
// GET /v1/external/config
// ------------------------------------------------------------------

export interface OverflowConfigResponse {
  config: Omit<OverflowConfig, 'preferredMarkets'> & { preferredMarkets: ExternalMarket[] }
}

function parsePreferredMarkets(raw: string): ExternalMarket[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m): m is ExternalMarket => EXTERNAL_MARKETS.includes(m))
  } catch {
    return []
  }
}

function serializeConfig(config: OverflowConfig): OverflowConfigResponse['config'] {
  const { preferredMarkets, ...rest } = config
  return { ...rest, preferredMarkets: parsePreferredMarkets(preferredMarkets) }
}

export async function getOverflowConfigResponse(
  prisma: PrismaClient,
): Promise<HandlerResult<OverflowConfigResponse>> {
  const config = await getOrCreateOverflowConfig(prisma)
  return ok(200, { config: serializeConfig(config) })
}

// ------------------------------------------------------------------
// PATCH /v1/external/config
// ------------------------------------------------------------------

export interface UpdateOverflowConfigInput {
  enabled?: boolean
  simulationMode?: boolean
  idleThresholdMinutes?: number
  demandThresholdPercent?: number
  marginProtectionPercent?: number
  gracePeriodSeconds?: number
  preferredMarkets?: ExternalMarket[]
}

export async function updateOverflowConfig(
  prisma: PrismaClient,
  input: UpdateOverflowConfigInput,
): Promise<HandlerResult<OverflowConfigResponse>> {
  // Ensure row exists so the update below hits a concrete record.
  await getOrCreateOverflowConfig(prisma)

  const data: Record<string, unknown> = {}
  if (input.enabled !== undefined) data.enabled = input.enabled
  if (input.simulationMode !== undefined) data.simulationMode = input.simulationMode
  if (input.idleThresholdMinutes !== undefined) data.idleThresholdMinutes = input.idleThresholdMinutes
  if (input.demandThresholdPercent !== undefined) data.demandThresholdPercent = input.demandThresholdPercent
  if (input.marginProtectionPercent !== undefined) data.marginProtectionPercent = input.marginProtectionPercent
  if (input.gracePeriodSeconds !== undefined) data.gracePeriodSeconds = input.gracePeriodSeconds
  if (input.preferredMarkets !== undefined) {
    data.preferredMarkets = JSON.stringify(input.preferredMarkets)
  }

  const updated = await prisma.overflowConfig.update({
    where: { id: 'singleton' },
    data,
  })

  return ok(200, { config: serializeConfig(updated) })
}
