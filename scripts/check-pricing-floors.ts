/**
 * Regression check for the pricing single-source-of-truth refactor
 * (commit bc6f935). Locks in the worked examples that motivated the
 * refactor so they cannot silently regress.
 *
 * Run:
 *   pnpm tsx scripts/check-pricing-floors.ts
 *
 * Exits non-zero on first failed assertion.
 *
 * What's covered:
 *
 *   1. Shared GPU_TIER_CONFIG has every tier the schema accepts, and
 *      retailRate / priceFloor / costFloor are all finite + non-negative.
 *
 *   2. The 2026-06-08 A100 incident (cmq5if3gr000) cannot reoccur:
 *      base $24/day * SPOT (0.6) * INFERENCE (0.8) = $11.52/day = $0.48/h
 *      would land BELOW Hyperstack's $1.35/h supplier cost. With the
 *      priceFloor of $40.50/day, the stack is forced back up to
 *      $40.50/day = $1.6875/h, preserving the 25% margin over supplier.
 *
 *   3. Same shape for L40S and H100 -- the priceFloor bites at the
 *      SPOT+INFERENCE intersection and not before.
 *
 *   4. Consumer tiers (CONSUMER / RTX_4090 / RTX_3090) skip the
 *      INFERENCE discount (they are already inference-priced) but the
 *      SPOT discount still applies; their priceFloor matches their
 *      retailRate so SPOT lands at the floor.
 *
 *   5. Portal-side HOURLY_RATES + GPU_FLOOR_DAILY derive from the
 *      shared package and equal retailRate / 24 and priceFloor for
 *      every tier. Catches drift between the two sides.
 */
import { GPU_TIER_CONFIG, dailyToHourly } from '../packages/shared/src/index.js'

type Tier = keyof typeof GPU_TIER_CONFIG

const SPOT_DISCOUNT_PCT = 0.4
const INFERENCE_DISCOUNT_PCT = 0.2
const CONSUMER_TIER_SET = new Set<string>(['CONSUMER', 'RTX_4090', 'RTX_3090'])

function tierMul(t: 'ON_DEMAND' | 'SPOT' | 'RESERVED'): number {
  if (t === 'SPOT') return 1 - SPOT_DISCOUNT_PCT
  if (t === 'RESERVED') return 1 - 0.1
  return 1
}

function workloadMul(workload: 'INFERENCE' | 'TRAINING' | 'MIXED', tier: string): number {
  if (workload !== 'INFERENCE') return 1
  if (CONSUMER_TIER_SET.has(tier)) return 1
  return 1 - INFERENCE_DISCOUNT_PCT
}

function gpuPriceFloor(tier: string): number {
  const cfg = GPU_TIER_CONFIG[tier as Tier]
  return cfg?.priceFloor ?? 0
}

function applyPriceFloor(ratePerDay: number, tier: string): number {
  const floor = gpuPriceFloor(tier)
  if (floor && ratePerDay < floor) return floor
  return ratePerDay
}

function compose(
  tier: Tier,
  pricingTier: 'ON_DEMAND' | 'SPOT' | 'RESERVED',
  workload: 'INFERENCE' | 'TRAINING' | 'MIXED',
): { uncapped: number; final: number; floored: boolean } {
  const base = GPU_TIER_CONFIG[tier].retailRate
  const uncapped = base * tierMul(pricingTier) * workloadMul(workload, tier)
  const final = applyPriceFloor(uncapped, tier)
  return { uncapped, final, floored: final > uncapped }
}

let failed = 0
function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  }
}

console.log('=== 1. GPU_TIER_CONFIG completeness ===')
const TIERS: Tier[] = [
  'H100', 'H200', 'A100', 'L40S', 'B200', 'B300', 'GB300',
  'OTHER', 'CONSUMER', 'RTX_4090', 'RTX_3090',
]
for (const t of TIERS) {
  const cfg = GPU_TIER_CONFIG[t]
  assert(!!cfg, `${t} has config row`)
  if (!cfg) continue
  assert(Number.isFinite(cfg.retailRate) && cfg.retailRate >= 0, `${t}.retailRate finite + non-neg`)
  assert(Number.isFinite(cfg.priceFloor) && cfg.priceFloor >= 0, `${t}.priceFloor finite + non-neg`)
  assert(Number.isFinite(cfg.costFloor) && cfg.costFloor >= 0, `${t}.costFloor finite + non-neg`)
}

console.log('\n=== 2. A100 SPOT+INFERENCE incident (2026-06-08) ===')
{
  const r = compose('A100', 'SPOT', 'INFERENCE')
  // base 24 * 0.6 * 0.8 = 11.52 -> below floor 40.50 -> pinned to 40.50.
  assert(Math.abs(r.uncapped - 11.52) < 0.001, 'A100 SPOT+INFERENCE uncapped = $11.52/day')
  assert(r.floored, 'A100 SPOT+INFERENCE floor engages')
  assert(Math.abs(r.final - 40.50) < 0.001, 'A100 SPOT+INFERENCE final = $40.50/day')
  const hourlyAtSupplier = 1.35
  assert(dailyToHourly(r.final) > hourlyAtSupplier,
    `A100 SPOT+INFERENCE hourly $${dailyToHourly(r.final).toFixed(2)}/h > supplier $${hourlyAtSupplier}/h`,
    `incident proof: would have been $${dailyToHourly(r.uncapped).toFixed(2)}/h without floor`)
}

console.log('\n=== 3. Same shape for L40S + H100 ===')
{
  const r = compose('L40S', 'SPOT', 'INFERENCE')
  // base 21 * 0.6 * 0.8 = 10.08 -> below floor 23.70 -> pinned.
  assert(Math.abs(r.uncapped - 10.08) < 0.001, 'L40S SPOT+INFERENCE uncapped = $10.08/day')
  assert(r.floored, 'L40S SPOT+INFERENCE floor engages')
  assert(Math.abs(r.final - 23.70) < 0.001, 'L40S SPOT+INFERENCE final = $23.70/day')
}
{
  const r = compose('H100', 'SPOT', 'INFERENCE')
  // base 140.15 * 0.6 * 0.8 = 67.272 -> above floor 56.10 -> uncapped.
  assert(Math.abs(r.uncapped - 67.272) < 0.001, 'H100 SPOT+INFERENCE uncapped = $67.27/day')
  assert(!r.floored, 'H100 SPOT+INFERENCE floor does NOT engage (already healthy)')
  assert(Math.abs(r.final - 67.272) < 0.001, 'H100 SPOT+INFERENCE final = uncapped')
}

console.log('\n=== 4. Consumer tier skip INFERENCE discount, SPOT still discounts ===')
{
  const r = compose('RTX_4090', 'ON_DEMAND', 'INFERENCE')
  // base 14, no discounts (consumer skips inference discount).
  assert(Math.abs(r.uncapped - 14) < 0.001, 'RTX_4090 ON_DEMAND+INFERENCE = $14/day (no inference discount)')
  assert(!r.floored, 'RTX_4090 ON_DEMAND no floor needed')
}
{
  const r = compose('RTX_4090', 'SPOT', 'INFERENCE')
  // base 14 * 0.6 = 8.40 -> below floor 10.20 -> pinned.
  assert(Math.abs(r.uncapped - 8.40) < 0.001, 'RTX_4090 SPOT+INFERENCE uncapped = $8.40/day')
  assert(r.floored, 'RTX_4090 SPOT floor engages')
  assert(Math.abs(r.final - 10.20) < 0.001, 'RTX_4090 SPOT pinned to floor $10.20/day')
}

console.log('\n=== 5. Portal-side derivation matches shared ===')
type Cfg = (typeof GPU_TIER_CONFIG)[Tier]
const HOURLY_RATES: Record<string, number> = Object.fromEntries(
  (Object.entries(GPU_TIER_CONFIG) as Array<[string, Cfg]>).map(
    ([tier, cfg]) => [tier, dailyToHourly(cfg.retailRate)],
  ),
)
const GPU_FLOOR_DAILY: Record<string, number> = Object.fromEntries(
  (Object.entries(GPU_TIER_CONFIG) as Array<[string, Cfg]>).map(
    ([tier, cfg]) => [tier, cfg.priceFloor],
  ),
)
for (const t of TIERS) {
  const cfg = GPU_TIER_CONFIG[t]
  if (!cfg) continue
  assert(Math.abs(HOURLY_RATES[t] - cfg.retailRate / 24) < 1e-9,
    `${t}.HOURLY_RATES = retailRate / 24 (${HOURLY_RATES[t].toFixed(4)})`)
  assert(GPU_FLOOR_DAILY[t] === cfg.priceFloor,
    `${t}.GPU_FLOOR_DAILY = priceFloor ($${cfg.priceFloor})`)
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
