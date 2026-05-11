/**
 * M5.8 / D3: per-rental CO2 estimator.
 *
 * Pure function. Given (gpuTier, gpuCount, durationMinutes, region) it
 * returns the estimated CO2 emissions in grams using two static lookup
 * tables: GPU TDP (watts) and region grid carbon intensity (g CO2 per
 * kWh). The estimator is intentionally simple so a buyer can audit the
 * math from the dashboard footnote.
 *
 * Math:
 *   power_kwh = (TDP_watts * gpuCount * durationMinutes / 60) / 1000
 *   co2_grams = power_kwh * region_intensity_g_per_kwh
 *
 * Example for 1 x H100 in US-EAST for 60 minutes:
 *   (700 * 1 * 60 / 60) / 1000 = 0.7 kWh
 *   0.7 kWh * 380 g/kWh = 266 g CO2
 *
 * Numbers used:
 *   - GPU TDP figures are peak design power draw from NVIDIA spec
 *     sheets. Real-world draw is typically 60-90% of TDP, so this is a
 *     conservative (high) estimate. Better to over-disclose CO2 than
 *     to undersell the impact.
 *   - Region grid intensity comes from 2024-2026 public grid data
 *     averages. They are honest approximations, not measured per-hour
 *     marginal intensities, and are documented inline so the
 *     dashboard footnote can match.
 *   - Unknown region falls back to the global average. This avoids
 *     silently zeroing out the estimate when a node has no region
 *     tag yet.
 */

import type { GpuTier } from '@a2e/shared'

// GPU peak power draw in watts. OTHER tier defaults to a conservative
// 700W since custom hardware can be anything; that keeps the estimate
// from collapsing to zero on a node where we don't know the silicon.
export const GPU_TDP_WATTS: Record<GpuTier, number> = {
  H100: 700,
  H200: 700,
  B200: 1000,
  B300: 1200,
  GB300: 1400,
  OTHER: 700,
}

// Region grid carbon intensity (g CO2 / kWh).
// Sources: EIA, Ember Climate, IEA grid mix reports (2024-2026 avgs).
// We map our short region codes to a representative intensity for the
// dominant grid in that region. The map is intentionally coarse;
// per-hour marginal intensity would be more accurate but is overkill
// for a buyer-facing disclosure.
export const REGION_GRID_INTENSITY_G_PER_KWH: Record<string, number> = {
  'US-WEST':     290, // CA/OR mix, high renewables and hydro
  'US-EAST':     380, // PJM mix, more coal and natural gas
  'EU':          250, // EU-27 average, high renewables share
  'APAC':        540, // SG/JP mix, more fossil
  'SA':          140, // BR/CL mix, dominated by hydro
  'OC':          530, // AU mix, coal-heavy
}
export const DEFAULT_GRID_INTENSITY_G_PER_KWH = 400

export interface CarbonEstimateInput {
  gpuTier: GpuTier
  gpuCount: number
  durationMinutes: number
  region: string | null | undefined
}

export interface CarbonEstimate {
  co2Grams: number
  energyKwh: number
  tdpWatts: number
  gridIntensityGPerKwh: number
  regionUsed: string // 'GLOBAL_AVG' if region was unknown/null
}

export function estimateCarbon(input: CarbonEstimateInput): CarbonEstimate {
  const tdpWatts = GPU_TDP_WATTS[input.gpuTier] ?? GPU_TDP_WATTS.OTHER
  const regionKey = (input.region ?? '').toUpperCase()
  const gridIntensity = REGION_GRID_INTENSITY_G_PER_KWH[regionKey] ?? DEFAULT_GRID_INTENSITY_G_PER_KWH
  const regionUsed = REGION_GRID_INTENSITY_G_PER_KWH[regionKey] !== undefined ? regionKey : 'GLOBAL_AVG'

  const minutes = Math.max(0, input.durationMinutes)
  const count = Math.max(0, input.gpuCount)
  const energyKwh = (tdpWatts * count * minutes) / 60 / 1000
  const co2Grams = energyKwh * gridIntensity

  return {
    co2Grams: Number(co2Grams.toFixed(2)),
    energyKwh: Number(energyKwh.toFixed(4)),
    tdpWatts,
    gridIntensityGPerKwh: gridIntensity,
    regionUsed,
  }
}

/**
 * Convenience: just the grams. Used by the meter where the full
 * breakdown isn't needed.
 */
export function estimateCo2Grams(input: CarbonEstimateInput): number {
  return estimateCarbon(input).co2Grams
}
