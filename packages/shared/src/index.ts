// A²E Shared Types and Utilities

// GPU Tiers supported by TokenOS. Wave 2 added CONSUMER + RTX_4090 +
// RTX_3090 — these are inference-only at the allocator level (see
// WorkloadType + compute-allocator.ts). L40S is a datacenter mid-tier
// (ada-lovelace), eligible for every workload type just like H/B-series.
export type GpuTier = 'H100' | 'H200' | 'A100' | 'L40S' | 'B200' | 'B300' | 'GB300' | 'OTHER' | 'CONSUMER' | 'RTX_4090' | 'RTX_3090'

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

// Rate information per GPU tier (daily rates in USD).
// SINGLE SOURCE OF TRUTH for pricing across server (buyer-compute.ts)
// and client (portal buyer/request page). Prior duplicated tables in
// each location drifted out of sync, causing A100 to sell below
// supplier cost on 2026-06-08 (cmq5if3gr000). This table is now
// imported on both sides; do not duplicate.
//
// Fields:
//   retailRate ($/day): catalog display rate buyers see. Drives the
//     "Total Cost" line item and the base of all discount math.
//   priceFloor ($/day): hard minimum we'll sell at, calibrated to the
//     cheapest cascade supplier cost × 25% margin. SPOT + INFERENCE
//     discounts that would dip the buyer rate below this get pinned to
//     this floor. Calibration source: 2026-06 cascade probe results.
//   costFloor ($/day): legacy break-even number (operator-only view).
//     Kept for backward compat with non-rental flows; new code should
//     prefer priceFloor.
//   vram (GB): for catalog filtering / display.
//   tier: internal sort order; T1=highest-end.
export const GPU_TIER_CONFIG: Record<
  GpuTier,
  {
    retailRate: number
    priceFloor: number
    costFloor: number
    vram: number
    tier: number
  }
> = {
  // H100 priceFloor: Shadeform latitude $1.66/h × 24 × 1.25 = $49.80
  // (rounded up to 56.10 to keep margin healthy across SXM5 / PCIe).
  H100: { retailRate: 140.15, priceFloor: 56.10, costFloor: 83, vram: 80, tier: 1 },
  // H200 priceFloor: Shadeform digitalocean $3.29/h × 24 × 1.25 = $98.70.
  H200: { retailRate: 179.85, priceFloor: 100.00, costFloor: 105, vram: 141, tier: 2 },
  // A100 priceFloor: Shadeform hyperstack A100_80G $1.35/h × 24 × 1.25
  // = $40.50. Critical: without this floor, INFERENCE + SPOT discounts
  // dropped buyer rate to $0.80/h (below $1.35 supplier cost). Live
  // on 2026-06-08 cmq5if3gr000 — we ate $0.55/h × runtime.
  A100: { retailRate: 24, priceFloor: 40.50, costFloor: 14, vram: 80, tier: 2.25 },
  // L40S priceFloor: Shadeform massedcompute $0.79/h × 24 × 1.25 = $23.70.
  L40S: { retailRate: 21, priceFloor: 23.70, costFloor: 12, vram: 48, tier: 2.5 },
  // B200 priceFloor: Shadeform verda $5.49/h × 24 × 1.25 = $164.70.
  B200: { retailRate: 321.1, priceFloor: 165.00, costFloor: 170, vram: 192, tier: 3 },
  B300: { retailRate: 431.75, priceFloor: 200.00, costFloor: 250, vram: 288, tier: 4 },
  GB300: { retailRate: 499.35, priceFloor: 240.00, costFloor: 300, vram: 288, tier: 5 },
  // OTHER: tiers with operator-declared custom rates skip the floor.
  OTHER: { retailRate: 0, priceFloor: 0, costFloor: 0, vram: 0, tier: 6 },
  // Consumer / prosumer floors calibrated to RunPod static + Vast.ai
  // verified prices × 1.25 margin.
  RTX_4090: { retailRate: 14, priceFloor: 10.20, costFloor: 8, vram: 24, tier: 7 },
  RTX_3090: { retailRate: 9, priceFloor: 9.00, costFloor: 5, vram: 24, tier: 8 },
  CONSUMER: { retailRate: 7, priceFloor: 6.00, costFloor: 4, vram: 12, tier: 9 },
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
