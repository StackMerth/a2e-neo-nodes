// A²E Shared Types and Utilities

// GPU Tiers supported by TokenOS
export type GpuTier = 'H100' | 'H200' | 'B200' | 'B300' | 'GB300'

// Node types
export type NodeType = 'PROVISIONED' | 'BYOG'

// Node status
export type NodeStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE'

// Job status
export type JobStatus = 'PENDING' | 'ROUTING' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED'

// Market types
export type Market = 'INTERNAL' | 'AKASH' | 'IONET'

// Rate information per GPU tier (daily rates in USD)
export const GPU_TIER_CONFIG: Record<
  GpuTier,
  {
    retailRate: number // Internal premium rate ($/day)
    costFloor: number // Minimum rate to break even ($/day)
    vram: number // GB
    tier: number // T1-T5
  }
> = {
  H100: { retailRate: 140.15, costFloor: 83, vram: 80, tier: 1 },
  H200: { retailRate: 179.85, costFloor: 105, vram: 141, tier: 2 },
  B200: { retailRate: 321.1, costFloor: 170, vram: 192, tier: 3 },
  B300: { retailRate: 431.75, costFloor: 250, vram: 288, tier: 4 },
  GB300: { retailRate: 499.35, costFloor: 300, vram: 288, tier: 5 },
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
