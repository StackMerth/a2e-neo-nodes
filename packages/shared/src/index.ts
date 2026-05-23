// A²E Shared Types and Utilities

// GPU Tiers supported by TokenOS. Wave 2 added CONSUMER + RTX_4090 +
// RTX_3090 — these are inference-only at the allocator level (see
// WorkloadType + compute-allocator.ts). L40S is a datacenter mid-tier
// (ada-lovelace), eligible for every workload type just like H/B-series.
export type GpuTier = 'H100' | 'H200' | 'L40S' | 'B200' | 'B300' | 'GB300' | 'OTHER' | 'CONSUMER' | 'RTX_4090' | 'RTX_3090'

// Buyer-declared workload type — drives the allocator's consumer-tier
// eligibility filter. INFERENCE matches all tiers; TRAINING/MIXED
// hard-filter out consumer tiers (they aren't designed for sustained
// multi-day loads).
export type WorkloadType = 'INFERENCE' | 'TRAINING' | 'MIXED'

// Subset of GpuTier that's only allowed for INFERENCE workloads. Used
// by the allocator + buyer request form to validate / grey-out cards.
export const CONSUMER_TIERS: GpuTier[] = ['CONSUMER', 'RTX_4090', 'RTX_3090']

export function isConsumerTier(tier: GpuTier): boolean {
  return CONSUMER_TIERS.includes(tier)
}

// Node types
export type NodeType = 'PROVISIONED' | 'BYOG'

// Node status
export type NodeStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE'

// Job status
export type JobStatus = 'PENDING' | 'ROUTING' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED'

// Market types
export type Market = 'INTERNAL' | 'AKASH' | 'IONET' | 'VASTAI'

// Rate information per GPU tier (daily rates in USD)
export const GPU_TIER_CONFIG: Record<
  GpuTier,
  {
    retailRate: number // Internal premium rate ($/day)
    costFloor: number // Minimum rate to break even ($/day)
    vram: number // GB
    tier: number // T1-T6 (OTHER is tier 6)
  }
> = {
  H100: { retailRate: 140.15, costFloor: 83, vram: 80, tier: 1 },
  H200: { retailRate: 179.85, costFloor: 105, vram: 141, tier: 2 },
  // L40S: datacenter Ada-Lovelace card. Mid-tier between H100 and
  // consumer RTX. Market reference ~$0.88/hr (Vast.ai, RunPod, AITECH).
  // $21/day ≈ $0.875/hr. Cost floor leaves room for operator margin.
  L40S: { retailRate: 21, costFloor: 12, vram: 48, tier: 2.5 },
  B200: { retailRate: 321.1, costFloor: 170, vram: 192, tier: 3 },
  B300: { retailRate: 431.75, costFloor: 250, vram: 288, tier: 4 },
  GB300: { retailRate: 499.35, costFloor: 300, vram: 288, tier: 5 },
  OTHER: { retailRate: 0, costFloor: 0, vram: 0, tier: 6 }, // Custom rates from node config
  // C2 wave 2: consumer / prosumer tiers. Pricing is market-standard
  // based on Vast.ai + RunPod consumer spot rates. Admin can override
  // via the YieldFloor table from the /rates page.
  RTX_4090: { retailRate: 14, costFloor: 8, vram: 24, tier: 7 },
  RTX_3090: { retailRate: 9, costFloor: 5, vram: 24, tier: 8 },
  CONSUMER: { retailRate: 7, costFloor: 4, vram: 12, tier: 9 }, // catchall floor
}

// Convert daily rate to hourly
export function dailyToHourly(dailyRate: number): number {
  return dailyRate / 24
}

// Convert hourly rate to daily
export function hourlyToDaily(hourlyRate: number): number {
  return hourlyRate * 24
}

// Routing decision interface
export interface RoutingDecision {
  market: Market
  ratePerHour: number
  ratePerDay: number
  reason: string
  timestamp: Date
  yieldFloorApplied: boolean
}

// Node registration request
export interface NodeRegistrationRequest {
  walletAddress: string
  gpuTier: GpuTier
  nodeType: NodeType
  region?: string
}

// Node information
export interface NodeInfo {
  id: string
  walletAddress: string
  gpuTier: GpuTier
  nodeType: NodeType
  status: NodeStatus
  region?: string
  lastHeartbeat: Date
  createdAt: Date
}

// Job routing request (main integration point)
export interface RouteRequest {
  deploymentId: string
  gpuTier: GpuTier
  durationSeconds?: number
}

// Job routing response
export interface RouteResponse {
  market: Market
  ratePerHour: number
  ratePerDay: number
  reason: string
  timestamp: string
}

// Market rate information
export interface MarketRate {
  market: Market
  gpuTier: GpuTier
  ratePerHour: number
  ratePerDay: number
  available: boolean
  fetchedAt: Date
}

// Earnings summary
export interface EarningsSummary {
  nodeId: string
  totalEarnings: number
  totalGpuSeconds: number
  byMarket: Record<Market, number>
  period: {
    start: Date
    end: Date
  }
}
