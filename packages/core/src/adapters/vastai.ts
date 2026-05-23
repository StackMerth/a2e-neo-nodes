import { randomUUID } from 'node:crypto'
import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  DeploymentCostResult,
  DeploymentStatusResult,
  ExternalMarketAdapter,
  MarketRateInfo,
} from '../rate-provider'
import { isSimulationMode } from '../external-simulation-config'
import { SimulationStore } from './simulation'

interface VastAiOffer {
  id?: number
  gpu_name?: string
  dph_total?: number
  num_gpus?: number
  verified?: boolean
  rentable?: boolean
  cuda_max_good?: number
  inet_down?: number
  inet_up?: number
  reliability2?: number
}

interface VastAiBundlesResponse {
  offers?: VastAiOffer[]
}

interface VastAiCreateInstanceResponse {
  success?: boolean
  new_contract?: number
  error?: string
  msg?: string
}

interface VastAiInstance {
  id?: number
  actual_status?: string
  intended_status?: string
  cur_state?: string
  start_date?: number
  end_date?: number
  dph_total?: number
  num_gpus?: number
  gpu_name?: string
  machine_id?: number
  label?: string
  ssh_host?: string
  ssh_port?: number
  status_msg?: string
}

interface VastAiInstanceResponse {
  instances?: VastAiInstance | VastAiInstance[]
}

const DEFAULT_DEPLOY_IMAGE = 'pytorch/pytorch:latest'
const DEFAULT_DISK_GB = 10

const GPU_TIER_TO_VASTAI: Record<GpuTier, string[]> = {
  H100: ['H100', 'H100 SXM', 'H100 PCIE'],
  H200: ['H200'],
  // L40S: Vast.ai lists these as a distinct SKU; PCIE is the only
  // current form factor for the L40S.
  L40S: ['L40S', 'L40S PCIE'],
  B200: ['B200'],
  B300: ['B300'],
  GB300: ['GB300'],
  OTHER: [], // Custom GPUs - no direct Vast.ai mapping, use estimated rates
  // C2 wave 2: Vast.ai does list consumer cards, but the allocator
  // filters consumer tiers off external markets anyway (their pricing
  // is on internal A2E inventory). Empty arrays mean an accidental
  // lookup returns no match rather than a partial one against a
  // listing we never intend to deploy onto.
  RTX_4090: [],
  RTX_3090: [],
  CONSUMER: [],
}

interface LiveDeploymentRecord {
  externalId: string
  askId: number
  ratePerHour: number
  startDateMs: number
}

export class VastAiAdapter implements ExternalMarketAdapter {
  readonly market = 'VASTAI' as const
  private enabled: boolean
  private apiEndpoint: string
  private apiKey: string | undefined
  private readonly simulationMode: boolean
  private readonly store: SimulationStore | null
  private readonly liveDeployments: Map<string, LiveDeploymentRecord> = new Map()

  constructor(
    options: {
      enabled?: boolean
      apiEndpoint?: string
      apiKey?: string
      simulationMode?: boolean
    } = {}
  ) {
    this.enabled = options.enabled ?? (process.env.VASTAI_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.VASTAI_API_ENDPOINT ?? 'https://console.vast.ai/api/v0'
    this.apiKey = options.apiKey ?? process.env.VASTAI_API_KEY
    this.simulationMode = options.simulationMode ?? isSimulationMode('VASTAI')
    this.store = this.simulationMode ? new SimulationStore() : null
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error('Vast.ai live mode requires VASTAI_API_KEY')
    }
    return this.apiKey
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.requireApiKey()}`,
    }
  }

  private mapVastStatusToInternal(actual: string | undefined, intended: string | undefined): import('../rate-provider').DeploymentStatus {
    const a = (actual || '').toLowerCase()
    const i = (intended || '').toLowerCase()
    if (a === 'running' && i === 'running') return 'ACTIVE'
    if (a === 'exited' || a === 'stopped' || a === 'offline') return 'TERMINATED'
    if (i === 'stopped' && (a === 'stopping' || a === 'running')) return 'TERMINATING'
    if (a === 'error') return 'FAILED'
    return 'PENDING'
  }

  private extractInstance(payload: VastAiInstanceResponse): VastAiInstance | null {
    const inst = payload.instances
    if (!inst) return null
    if (Array.isArray(inst)) return inst[0] ?? null
    return inst
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  async getRate(gpuTier: GpuTier): Promise<MarketRateInfo> {
    if (!this.enabled) {
      return {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: new Date(),
      }
    }

    try {
      const apiPricing = await this.fetchFromApi(gpuTier)
      const pricing = apiPricing ?? this.getEstimatedRate(gpuTier)

      return {
        ratePerHour: pricing.pricePerHour,
        ratePerDay: pricing.pricePerHour * 24,
        available: pricing.available,
        fetchedAt: new Date(),
      }
    } catch (error) {
      console.error('Vast.ai rate fetch failed:', error)
      return {
        ratePerHour: 0,
        ratePerDay: 0,
        available: false,
        fetchedAt: new Date(),
      }
    }
  }

  async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    if (this.simulationMode && this.store) {
      const rate = await this.getRate(input.gpuTier)
      if (!rate.available || rate.ratePerHour <= 0) {
        throw new Error(`Vast.ai: rate unavailable for tier ${input.gpuTier}`)
      }

      const externalId = `sim-vastai-${randomUUID()}`
      this.store.create({
        externalId,
        market: this.market,
        nodeId: input.nodeId,
        gpuTier: input.gpuTier,
        ratePerHour: rate.ratePerHour,
      })
      this.store.appendLog(externalId, `[sim] deployment created for ${input.nodeId}`)

      return {
        externalId,
        status: 'PENDING',
        estimatedRatePerHour: rate.ratePerHour,
        market: this.market,
      }
    }

    return this.createLiveDeployment(input)
  }

  async getDeploymentStatus(externalId: string): Promise<DeploymentStatusResult> {
    if (this.simulationMode && this.store) {
      const state = this.store.tick(externalId)
      if (!state) {
        throw new Error(`Vast.ai: unknown deployment ${externalId}`)
      }
      return {
        externalId,
        status: state.status,
        message: `simulation status: ${state.status.toLowerCase()}`,
      }
    }

    const apiKey = this.requireApiKey()
    void apiKey
    const response = await fetch(`${this.apiEndpoint}/instances/${externalId}/`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.status === 404) {
      // Vast.ai removes destroyed instances; treat as TERMINATED.
      return {
        externalId,
        status: 'TERMINATED',
        message: 'instance not found (likely destroyed)',
      }
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Vast.ai status fetch failed: ${response.status} ${text.slice(0, 200)}`)
    }

    const data = (await response.json()) as VastAiInstanceResponse
    const inst = this.extractInstance(data)
    if (!inst) {
      return {
        externalId,
        status: 'TERMINATED',
        message: 'no instance payload returned',
      }
    }

    const status = this.mapVastStatusToInternal(inst.actual_status, inst.intended_status)
    return {
      externalId,
      status,
      message: inst.status_msg || `vastai status: actual=${inst.actual_status} intended=${inst.intended_status}`,
    }
  }

  async terminateDeployment(externalId: string): Promise<void> {
    if (this.simulationMode && this.store) {
      const existing = this.store.get(externalId)
      if (!existing) return
      this.store.terminate(externalId)
      this.store.appendLog(externalId, '[sim] terminated')
      return
    }

    const response = await fetch(`${this.apiEndpoint}/instances/${externalId}/`, {
      method: 'DELETE',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    // 404 means already gone — idempotent.
    if (response.status === 404) {
      this.liveDeployments.delete(externalId)
      return
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Vast.ai terminate failed: ${response.status} ${text.slice(0, 200)}`)
    }

    this.liveDeployments.delete(externalId)
  }

  async getDeploymentLogs(externalId: string): Promise<string> {
    if (this.simulationMode && this.store) {
      const state = this.store.get(externalId)
      if (!state) {
        throw new Error(`Vast.ai: unknown deployment ${externalId}`)
      }
      return state.logs.join('\n')
    }

    // Vast.ai's log endpoint is async (request, then poll S3 url). For our
    // overflow use case the instance status payload already contains the
    // diagnostic message we surface in the dashboard. Returning it here keeps
    // the contract simple and avoids long-running polls inside a request.
    const response = await fetch(`${this.apiEndpoint}/instances/${externalId}/`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      return `[no logs available — instance fetch returned ${response.status}]`
    }

    const data = (await response.json()) as VastAiInstanceResponse
    const inst = this.extractInstance(data)
    if (!inst) return '[no instance payload]'

    return [
      `vastai instance ${inst.id}`,
      `gpu: ${inst.gpu_name} x${inst.num_gpus}`,
      `actual_status: ${inst.actual_status}`,
      `intended_status: ${inst.intended_status}`,
      `dph_total: ${inst.dph_total}`,
      `start_date: ${inst.start_date}`,
      inst.status_msg ? `status_msg: ${inst.status_msg}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  async getDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    if (this.simulationMode && this.store) {
      const state = this.store.get(externalId)
      if (!state) {
        throw new Error(`Vast.ai: unknown deployment ${externalId}`)
      }
      const accumulatedUsd = this.store.computeAccumulatedUsd(externalId)
      return {
        accumulatedUsd,
        nativeAmount: accumulatedUsd,
        nativeCurrency: 'USD',
      }
    }

    // Vast.ai's `start_date` field on the instance payload is set when the
    // instance is *reserved*, not when it actually starts running. For
    // instances that never progress past PENDING (or are terminated quickly),
    // start_date can be hours or days in the past, producing wildly inflated
    // cost numbers. We bound elapsed time by the locally-tracked create-time,
    // which is the truthful upper bound for our exposure.

    const local = this.liveDeployments.get(externalId)

    const response = await fetch(`${this.apiEndpoint}/instances/${externalId}/`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.status === 404) {
      if (!local) {
        return { accumulatedUsd: 0, nativeAmount: 0, nativeCurrency: 'USD' }
      }
      const elapsedHours = Math.max(0, (Date.now() - local.startDateMs) / 3_600_000)
      const cost = local.ratePerHour * elapsedHours
      return { accumulatedUsd: cost, nativeAmount: cost, nativeCurrency: 'USD' }
    }

    if (!response.ok) {
      // Don't throw — operators rely on this for billing readouts. Fall back
      // to local-record estimate; the source of truth for actual money is
      // Vast.ai's account billing, surfaced separately.
      if (local) {
        const elapsedHours = Math.max(0, (Date.now() - local.startDateMs) / 3_600_000)
        return {
          accumulatedUsd: local.ratePerHour * elapsedHours,
          nativeAmount: local.ratePerHour * elapsedHours,
          nativeCurrency: 'USD',
        }
      }
      return { accumulatedUsd: 0, nativeAmount: 0, nativeCurrency: 'USD' }
    }

    const data = (await response.json()) as VastAiInstanceResponse
    const inst = this.extractInstance(data)
    if (!inst || typeof inst.dph_total !== 'number') {
      return { accumulatedUsd: 0, nativeAmount: 0, nativeCurrency: 'USD' }
    }

    // Vast.ai billing rules — learned from production canary:
    //
    //   * `actual_status === 'running'` is the ONLY signal that the workload
    //     is actually executing and accruing charges. While loading or
    //     queued, `actual_status` is null/undefined.
    //   * `end_date` is the max-lease ceiling (often create-time + days),
    //     NOT the actual termination time. We must NOT treat `end_date`
    //     being set as proof the instance ran.
    //   * `start_date` is the reservation time, which can be set before the
    //     workload is actually billable.
    //
    // So: we only bill when `actual_status === 'running'`, and we always
    // measure elapsed time from the locally-tracked create timestamp up to
    // "now" (capped by Vast's `start_date` when later than local — i.e. the
    // workload only started after some queue time).
    if (inst.actual_status !== 'running') {
      return { accumulatedUsd: 0, nativeAmount: 0, nativeCurrency: 'USD' }
    }

    let effectiveStartMs: number | null = local?.startDateMs ?? null
    if (typeof inst.start_date === 'number' && inst.start_date > 0) {
      const apiStartMs = inst.start_date * 1000
      // If the API claims the run started later than our create call (queued
      // for a while), trust the API. Otherwise stick with the create call as
      // the upper bound.
      effectiveStartMs = effectiveStartMs == null ? apiStartMs : Math.max(apiStartMs, effectiveStartMs)
    }
    if (effectiveStartMs == null) {
      return { accumulatedUsd: 0, nativeAmount: 0, nativeCurrency: 'USD' }
    }

    const elapsedHours = Math.max(0, (Date.now() - effectiveStartMs) / 3_600_000)
    const cost = inst.dph_total * elapsedHours

    return {
      accumulatedUsd: cost,
      nativeAmount: cost,
      nativeCurrency: 'USD',
    }
  }

  /**
   * Live-mode deployment creation. Searches for verified rentable offers that
   * match the GPU tier, picks the cheapest, and PUTs to /asks/{ask_id}/ to
   * create an instance. Rolls up the chosen rate so cost tracking stays sane
   * even if the instance disappears later.
   */
  private async createLiveDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    const apiKey = this.requireApiKey()
    void apiKey
    const targetModels = GPU_TIER_TO_VASTAI[input.gpuTier]
    if (targetModels.length === 0) {
      throw new Error(`Vast.ai: no GPU mapping for tier ${input.gpuTier}`)
    }

    // 1. Search for an offer. Vast.ai's /bundles/ endpoint is GET-based with
    //    a URL-encoded JSON query parameter.
    const searchUrl = this.buildOffersUrl({
      gpu_name: { in: targetModels },
      verified: { eq: true },
      rentable: { eq: true },
      num_gpus: { eq: 1 },
    })
    const searchResp = await fetch(searchUrl, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    if (!searchResp.ok) {
      const text = await searchResp.text()
      throw new Error(`Vast.ai offer search failed: ${searchResp.status} ${text.slice(0, 200)}`)
    }

    const searchData = (await searchResp.json()) as VastAiBundlesResponse
    const offers = (searchData.offers ?? []).filter(
      (o) => typeof o.id === 'number' && typeof o.dph_total === 'number' && o.rentable !== false
    )
    if (offers.length === 0) {
      throw new Error(`Vast.ai: no rentable offers found for tier ${input.gpuTier}`)
    }

    // Sort cheapest-first; tiebreak on reliability.
    offers.sort((a, b) => {
      const priceDiff = (a.dph_total ?? Infinity) - (b.dph_total ?? Infinity)
      if (priceDiff !== 0) return priceDiff
      return (b.reliability2 ?? 0) - (a.reliability2 ?? 0)
    })

    const offer = offers[0]!
    const askId = offer.id!
    const ratePerHour = (offer.dph_total ?? 0) / Math.max(1, offer.num_gpus ?? 1)

    // 2. Create instance from the chosen ask.
    const createResp = await fetch(`${this.apiEndpoint}/asks/${askId}/`, {
      method: 'PUT',
      headers: this.authHeaders(),
      body: JSON.stringify({
        client_id: 'me',
        image: DEFAULT_DEPLOY_IMAGE,
        disk: DEFAULT_DISK_GB,
        runtype: 'ssh',
        label: `a2e-${input.nodeId}`.slice(0, 64),
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!createResp.ok) {
      const text = await createResp.text()
      throw new Error(`Vast.ai instance create failed: ${createResp.status} ${text.slice(0, 200)}`)
    }

    const createData = (await createResp.json()) as VastAiCreateInstanceResponse
    if (!createData.success || typeof createData.new_contract !== 'number') {
      throw new Error(`Vast.ai instance create returned non-success: ${JSON.stringify(createData).slice(0, 200)}`)
    }

    const externalId = String(createData.new_contract)
    this.liveDeployments.set(externalId, {
      externalId,
      askId,
      ratePerHour,
      startDateMs: Date.now(),
    })

    return {
      externalId,
      status: 'PENDING',
      estimatedRatePerHour: ratePerHour,
      market: this.market,
    }
  }

  private buildOffersUrl(query: Record<string, unknown>): string {
    // Vast.ai's /bundles/ endpoint takes a single `q` URL-encoded JSON param
    // via GET. This replaced the legacy POST body interface.
    const encoded = encodeURIComponent(JSON.stringify(query))
    return `${this.apiEndpoint}/bundles/?q=${encoded}`
  }

  private async fetchFromApi(gpuTier: GpuTier): Promise<{ pricePerHour: number; available: boolean } | null> {
    const targetModels = GPU_TIER_TO_VASTAI[gpuTier]

    if (targetModels.length === 0) {
      return null
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }

      const url = this.buildOffersUrl({
        gpu_name: { in: targetModels },
        verified: { eq: true },
        rentable: { eq: true },
      })

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        return null
      }

      const data = (await response.json()) as VastAiBundlesResponse
      return this.computeMedianRate(data, targetModels)
    } catch {
      return null
    }
  }

  private computeMedianRate(
    data: VastAiBundlesResponse,
    targetModels: string[]
  ): { pricePerHour: number; available: boolean } | null {
    if (!data.offers || !Array.isArray(data.offers) || data.offers.length === 0) {
      return null
    }

    const normalizedTargets = targetModels.map((m) => m.toLowerCase())
    const perGpuRates: number[] = []

    for (const offer of data.offers) {
      if (!offer.gpu_name || typeof offer.dph_total !== 'number') continue
      if (!offer.num_gpus || offer.num_gpus <= 0) continue

      const normalizedName = offer.gpu_name.toLowerCase()
      if (!normalizedTargets.some((t) => normalizedName.includes(t))) continue

      const perGpuRate = offer.dph_total / offer.num_gpus
      if (perGpuRate > 0) {
        perGpuRates.push(perGpuRate)
      }
    }

    if (perGpuRates.length === 0) {
      return null
    }

    perGpuRates.sort((a, b) => a - b)
    const mid = Math.floor(perGpuRates.length / 2)
    const median =
      perGpuRates.length % 2 === 0
        ? (perGpuRates[mid - 1]! + perGpuRates[mid]!) / 2
        : perGpuRates[mid]!

    return {
      pricePerHour: median,
      available: true,
    }
  }

  private getEstimatedRate(gpuTier: GpuTier): { pricePerHour: number; available: boolean } {
    // Vast.ai typically offers the cheapest rates (~55% of retail)
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const estimatedRate = tierConfig.retailRate * 0.55

    return {
      pricePerHour: dailyToHourly(estimatedRate),
      available: true,
    }
  }
}
