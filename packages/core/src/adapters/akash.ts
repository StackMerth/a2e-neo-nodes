/**
 * Akash adapter — live + simulation.
 *
 * Live-mode lifecycle:
 *   1. Lazy-init signer + chain SDK from AKASH_MNEMONIC.
 *   2. Ensure mTLS cert is published (one-time per wallet).
 *   3. Build SDL → groups + manifest hash.
 *   4. Submit MsgCreateDeployment with 5 AKT escrow.
 *   5. Poll getBids until at least one bid arrives or 60s timeout.
 *   6. Pick cheapest bid and submit MsgCreateLease.
 *   7. Track deployment locally for cost calc and idempotent terminate.
 *
 * Simulation mode (default) goes through SimulationStore — same shape as
 * VastAi sim. The two modes share the same external interface.
 *
 * NOTE on warranty: this code targets @akashnetwork/chain-sdk@1.0.0-alpha.31.
 * Per the project agreement with the client, breaking changes from upstream
 * Akash SDK releases fall outside the 30-day post-delivery warranty.
 */

import { randomUUID } from 'node:crypto'
import type { GpuTier } from '@a2e/shared'
import { GPU_TIER_CONFIG, dailyToHourly } from '@a2e/shared'
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  DeploymentCostResult,
  DeploymentStatus,
  DeploymentStatusResult,
  ExternalMarketAdapter,
  MarketRateInfo,
} from '../rate-provider'
import { isSimulationMode } from '../external-simulation-config'
import { SimulationStore } from './simulation'
import { generateManifest, generateManifestVersion, validateSDL } from '@akashnetwork/chain-sdk'
import type { GroupSpec } from '@akashnetwork/chain-sdk/private-types/akash.v1beta4'
import { Deployment_State } from '@akashnetwork/chain-sdk/private-types/akash.v1'
import { Bid_State } from '@akashnetwork/chain-sdk/private-types/akash.v1beta5'
import { buildSdl } from './akash-sdl'
import { createAkashSigner, type AkashSigner } from './akash-signer'
import { ensureCertificate } from './akash-cert'
import { getAktUsdRate } from './akash-rate'

interface AkashGpuPricing {
  model: string
  pricePerHour: number
  available: boolean
}

interface LiveDeploymentRecord {
  externalId: string
  owner: string
  dseq: bigint
  gseq: number
  oseq: number
  provider: string
  bseq: number
  pricePerBlockUakt: bigint
  startDateMs: number
}

const GPU_TIER_TO_AKASH: Record<GpuTier, string[]> = {
  H100: ['h100', 'nvidia-h100', 'H100 80GB'],
  H200: ['h200', 'nvidia-h200', 'H200'],
  B200: ['b200', 'nvidia-b200', 'B200'],
  B300: ['b300', 'nvidia-b300', 'B300'],
  GB300: ['gb300', 'nvidia-gb300', 'GB300'],
  OTHER: [],
}

const SIM_AKT_USD_PRICE = 3.5

// 5 AKT min deposit for a new deployment, in uakt.
const DEFAULT_DEPOSIT_UAKT = 5_000_000n
// Akash block time is roughly 6 seconds, giving 600 blocks/hour.
const BLOCKS_PER_HOUR = 600
// Bid polling: max 60s, 5s between polls.
const BID_POLL_TIMEOUT_MS = 60_000
const BID_POLL_INTERVAL_MS = 5_000

export class AkashAdapter implements ExternalMarketAdapter {
  readonly market = 'AKASH' as const
  private enabled: boolean
  private apiEndpoint: string
  private readonly simulationMode: boolean
  private readonly store: SimulationStore | null
  private readonly liveDeployments: Map<string, LiveDeploymentRecord> = new Map()
  private signerPromise: Promise<AkashSigner> | null = null

  constructor(
    options: { enabled?: boolean; apiEndpoint?: string; simulationMode?: boolean } = {}
  ) {
    this.enabled = options.enabled ?? (process.env.AKASH_ENABLED === 'true')
    this.apiEndpoint = options.apiEndpoint ?? process.env.AKASH_API_ENDPOINT ?? 'https://api.cloudmos.io'
    this.simulationMode = options.simulationMode ?? isSimulationMode('AKASH')
    this.store = this.simulationMode ? new SimulationStore() : null
  }

  isEnabled(): boolean {
    return this.enabled
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** Lazy single-init of the chain SDK signer, shared per adapter instance. */
  private async getSigner(): Promise<AkashSigner> {
    if (!this.signerPromise) {
      this.signerPromise = createAkashSigner()
    }
    return this.signerPromise
  }

  async getRate(gpuTier: GpuTier): Promise<MarketRateInfo> {
    if (!this.enabled) {
      return { ratePerHour: 0, ratePerDay: 0, available: false, fetchedAt: new Date() }
    }
    try {
      const pricing = await this.fetchPricing(gpuTier)
      if (!pricing || !pricing.available) {
        return { ratePerHour: 0, ratePerDay: 0, available: false, fetchedAt: new Date() }
      }
      return {
        ratePerHour: pricing.pricePerHour,
        ratePerDay: pricing.pricePerHour * 24,
        available: true,
        fetchedAt: new Date(),
      }
    } catch (error) {
      console.error('Akash rate fetch failed:', error)
      return { ratePerHour: 0, ratePerDay: 0, available: false, fetchedAt: new Date() }
    }
  }

  async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    if (this.simulationMode && this.store) {
      const rate = await this.getRate(input.gpuTier)
      if (!rate.available || rate.ratePerHour <= 0) {
        throw new Error(`Akash: rate unavailable for tier ${input.gpuTier}`)
      }
      const externalId = `sim-akash-${randomUUID()}`
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
      if (!state) throw new Error(`Akash: unknown deployment ${externalId}`)
      return { externalId, status: state.status, message: `simulation status: ${state.status.toLowerCase()}` }
    }
    return this.getLiveDeploymentStatus(externalId)
  }

  async terminateDeployment(externalId: string): Promise<void> {
    if (this.simulationMode && this.store) {
      const existing = this.store.get(externalId)
      if (!existing) return
      this.store.terminate(externalId)
      this.store.appendLog(externalId, '[sim] terminated')
      return
    }
    return this.terminateLiveDeployment(externalId)
  }

  async getDeploymentLogs(externalId: string): Promise<string> {
    if (this.simulationMode && this.store) {
      const state = this.store.get(externalId)
      if (!state) throw new Error(`Akash: unknown deployment ${externalId}`)
      return state.logs.join('\n')
    }
    // Live-mode logs live on the provider, fetched over mTLS — out of scope
    // for the initial canary. Surface a placeholder so callers can render
    // something meaningful in the dashboard.
    const rec = this.liveDeployments.get(externalId)
    if (!rec) return '[no log records — deployment may have been cleared]'
    return [
      `akash deployment dseq=${rec.dseq} gseq=${rec.gseq} oseq=${rec.oseq}`,
      `provider=${rec.provider}`,
      `pricePerBlockUakt=${rec.pricePerBlockUakt}`,
      'logs: provider mTLS endpoint not yet wired (see roadmap)',
    ].join('\n')
  }

  async getDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    if (this.simulationMode && this.store) {
      const state = this.store.get(externalId)
      if (!state) throw new Error(`Akash: unknown deployment ${externalId}`)
      const accumulatedUsd = this.store.computeAccumulatedUsd(externalId)
      return {
        accumulatedUsd,
        nativeAmount: accumulatedUsd / SIM_AKT_USD_PRICE,
        nativeCurrency: 'AKT',
      }
    }
    return this.getLiveDeploymentCost(externalId)
  }

  /* ────────────────────────── live mode internals ────────────────────────── */

  private async createLiveDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
    const signer = await this.getSigner()

    // Step 1: ensure the wallet has a published mTLS cert. One-time per wallet.
    await ensureCertificate(signer.sdk, signer.address)

    // Step 2: build SDL for the requested tier and validate it.
    const { document } = buildSdl({ nodeId: input.nodeId, gpuTier: input.gpuTier })
    const validation = validateSDL(document as never)
    if (validation && validation.length > 0) {
      throw new Error(`Akash SDL validation failed: ${JSON.stringify(validation).slice(0, 300)}`)
    }

    // Step 3: convert SDL → manifest groups + content hash.
    const manifestResult = generateManifest(document as never)
    if (!manifestResult.ok) {
      throw new Error(`Akash manifest generation failed: ${JSON.stringify(manifestResult.value).slice(0, 300)}`)
    }
    const groupSpecs: GroupSpec[] = manifestResult.value.groupSpecs
    const manifestHash = await generateManifestVersion(manifestResult.value.groups)

    // Step 4: submit MsgCreateDeployment.
    const dseq = BigInt(Math.floor(Date.now() / 1000))
    await signer.sdk.akash.deployment.v1beta4.createDeployment({
      id: { owner: signer.address, dseq },
      groups: groupSpecs,
      hash: manifestHash,
      deposit: {
        amount: { denom: 'uakt', amount: DEFAULT_DEPOSIT_UAKT.toString() },
        sources: [1], // Source.balance
      },
      reclamation: undefined,
    })

    // Step 5: poll for bids until one arrives or timeout.
    const winningBid = await this.pollForCheapestBid(signer, signer.address, dseq)
    if (!winningBid) {
      // No bids — close the deployment to recover the escrow before throwing.
      await this.safeCloseDeployment(signer, signer.address, dseq).catch(() => {})
      throw new Error(`Akash: no bids received within ${BID_POLL_TIMEOUT_MS / 1000}s for dseq=${dseq}`)
    }

    // Step 6: accept the bid via MsgCreateLease.
    await signer.sdk.akash.market.v1beta5.createLease({
      bidId: {
        owner: signer.address,
        dseq,
        gseq: winningBid.gseq,
        oseq: winningBid.oseq,
        provider: winningBid.provider,
        bseq: winningBid.bseq,
      },
    })

    // Step 7: book-keeping + return.
    const externalId = `${signer.address}/${dseq}/${winningBid.gseq}/${winningBid.oseq}/${winningBid.provider}`
    this.liveDeployments.set(externalId, {
      externalId,
      owner: signer.address,
      dseq,
      gseq: winningBid.gseq,
      oseq: winningBid.oseq,
      provider: winningBid.provider,
      bseq: winningBid.bseq,
      pricePerBlockUakt: winningBid.priceUakt,
      startDateMs: Date.now(),
    })

    const aktPerHour = Number(winningBid.priceUakt) * BLOCKS_PER_HOUR / 1_000_000
    const aktUsd = await getAktUsdRate()
    return {
      externalId,
      status: 'PENDING',
      estimatedRatePerHour: aktPerHour * aktUsd,
      market: this.market,
    }
  }

  private async pollForCheapestBid(
    signer: AkashSigner,
    owner: string,
    dseq: bigint
  ): Promise<{ gseq: number; oseq: number; provider: string; bseq: number; priceUakt: bigint } | null> {
    const deadline = Date.now() + BID_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const response = await signer.sdk.akash.market.v1beta5.getBids({
        filters: { owner, dseq, state: 'open' },
      })
      const openBids = (response.bids ?? []).filter((b) => b.bid?.state === Bid_State.open)
      if (openBids.length > 0) {
        // Pick the cheapest bid (smallest priceUakt).
        let best: { gseq: number; oseq: number; provider: string; bseq: number; priceUakt: bigint } | null = null
        for (const b of openBids) {
          const id = b.bid?.id
          const price = b.bid?.price
          if (!id || !price || !price.amount) continue
          // DecCoin amount can be a fractional string like "12345.000000000000000000" — parse and round.
          const priceUakt = BigInt(Math.round(Number(price.amount)))
          if (!best || priceUakt < best.priceUakt) {
            best = {
              gseq: id.gseq ?? 0,
              oseq: id.oseq ?? 0,
              provider: id.provider ?? '',
              bseq: id.bseq ?? 0,
              priceUakt,
            }
          }
        }
        if (best) return best
      }
      await new Promise((r) => setTimeout(r, BID_POLL_INTERVAL_MS))
    }
    return null
  }

  private async getLiveDeploymentStatus(externalId: string): Promise<DeploymentStatusResult> {
    const rec = this.liveDeployments.get(externalId)
    if (!rec) {
      return { externalId, status: 'TERMINATED', message: 'no local record (likely closed)' }
    }
    const signer = await this.getSigner()
    try {
      const lease = await signer.sdk.akash.market.v1beta5.getLease({
        id: {
          owner: rec.owner,
          dseq: rec.dseq,
          gseq: rec.gseq,
          oseq: rec.oseq,
          provider: rec.provider,
        },
      })
      const status = mapLeaseStateToInternal(lease.lease?.state)
      return { externalId, status, message: `lease state: ${lease.lease?.state}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Lease not found → was probably closed
      if (/not.*found/i.test(msg)) {
        return { externalId, status: 'TERMINATED', message: 'lease not found' }
      }
      return { externalId, status: 'PENDING', message: `status query error: ${msg}` }
    }
  }

  private async terminateLiveDeployment(externalId: string): Promise<void> {
    const rec = this.liveDeployments.get(externalId)
    if (!rec) return
    const signer = await this.getSigner()
    await this.safeCloseDeployment(signer, rec.owner, rec.dseq)
    this.liveDeployments.delete(externalId)
  }

  private async safeCloseDeployment(signer: AkashSigner, owner: string, dseq: bigint): Promise<void> {
    try {
      await signer.sdk.akash.deployment.v1beta4.closeDeployment({
        id: { owner, dseq },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Already closed → fine, idempotent.
      if (/closed|not.*found/i.test(msg)) return
      throw err
    }
  }

  private async getLiveDeploymentCost(externalId: string): Promise<DeploymentCostResult> {
    const rec = this.liveDeployments.get(externalId)
    if (!rec) {
      return { accumulatedUsd: 0, nativeAmount: 0, nativeCurrency: 'AKT' }
    }
    // Cost = pricePerBlock × elapsedBlocks. ElapsedBlocks ≈ elapsedSeconds / 6.
    // Capped by escrow available (5 AKT initial deposit).
    const elapsedSec = (Date.now() - rec.startDateMs) / 1000
    const elapsedBlocks = elapsedSec / 6
    const aktAmount = Number(rec.pricePerBlockUakt) * elapsedBlocks / 1_000_000
    const cappedAkt = Math.min(aktAmount, Number(DEFAULT_DEPOSIT_UAKT) / 1_000_000)
    const aktUsd = await getAktUsdRate()
    return {
      accumulatedUsd: cappedAkt * aktUsd,
      nativeAmount: cappedAkt,
      nativeCurrency: 'AKT',
    }
  }

  /* ────────────────────────── rate fetch (unchanged) ────────────────────────── */

  private async fetchPricing(gpuTier: GpuTier): Promise<AkashGpuPricing | null> {
    try {
      const response = await fetch(`${this.apiEndpoint}/v1/gpu-prices`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) {
        const data = await response.json()
        return this.findMatchingGpu(data, gpuTier)
      }
    } catch {
      // Fall back to estimated rates.
    }
    return this.getEstimatedRate(gpuTier)
  }

  private findMatchingGpu(apiData: unknown, gpuTier: GpuTier): AkashGpuPricing | null {
    const targetModels = GPU_TIER_TO_AKASH[gpuTier]
    if (!Array.isArray(apiData)) return null
    for (const item of apiData) {
      if (typeof item !== 'object' || item === null) continue
      const model = (item as Record<string, unknown>).model as string
      const price = (item as Record<string, unknown>).price as number
      const available = (item as Record<string, unknown>).available as boolean
      if (!model || typeof price !== 'number') continue
      const normalized = model.toLowerCase()
      if (targetModels.some((t) => normalized.includes(t.toLowerCase()))) {
        return { model, pricePerHour: price, available: available !== false }
      }
    }
    return null
  }

  private getEstimatedRate(gpuTier: GpuTier): AkashGpuPricing {
    const tierConfig = GPU_TIER_CONFIG[gpuTier]
    const estimatedRate = tierConfig.retailRate * 0.65
    return { model: gpuTier, pricePerHour: dailyToHourly(estimatedRate), available: true }
  }
}

export function mapLeaseStateToInternal(state: number | undefined): DeploymentStatus {
  // akash.market.v1beta5 Lease_State: invalid=0, active=1, insufficient_funds=2, closed=3
  switch (state) {
    case 1:
      return 'ACTIVE'
    case 2:
      return 'FAILED'
    case 3:
      return 'TERMINATED'
    default:
      return 'PENDING'
  }
}
