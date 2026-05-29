/**
 * Track 5 / M0.1 — seed the cost-of-service baseline tables.
 *
 * Idempotent. Upserts one GpuCostBaseline row per known SKU and one
 * PowerRate row per region. Safe to re-run after schema or rate
 * adjustments — the upsert refreshes the constants without touching
 * other tables.
 *
 * Run:   pnpm --filter @a2e/api seed:cost-baselines
 *
 * Cost methodology (per the M0.1 design):
 *   hourly cost = (kwhDraw × powerRate) + hardwareAmortHourly
 *               + bandwidthCostHourly + overheadHourly
 *
 * Numbers below are starting estimates derived from public retail/TCO
 * data:
 *   - kwhDraw       = TDP at typical sustained load, in kW
 *   - hardwareAmort = (retail price USD) / 26280 (3-year 24×7 lifetime)
 *   - bandwidth     = colo egress + cooling + rack share. Lower for
 *                     residential operators, higher for datacenter.
 *   - overhead      = platform-side monitoring/SLA reserve. Flat $0.05
 *
 * GLOBAL power rate seed: $0.12/kWh (rough US residential median).
 * Per-region rows can be added later without code changes.
 *
 * If admin needs to tune individual numbers post-seed, they should
 * edit the row directly via the DB or admin UI — re-running this
 * script will overwrite manual edits since it's an upsert.
 */
import { prisma } from '@a2e/database'

const GLOBAL_KWH_RATE = 0.12

interface GpuBaselineSeed {
  gpuSku: string
  gpuFamily: string
  kwhDraw: number
  hardwarePriceUsd: number
  bandwidthCostHourly: number
  notes: string
}

const HOURS_3YR = 26280

const GPU_BASELINES: GpuBaselineSeed[] = [
  // Datacenter — Hopper
  { gpuSku: 'H100_80GB',  gpuFamily: 'Hopper',     kwhDraw: 0.70, hardwarePriceUsd: 30000, bandwidthCostHourly: 0.30, notes: 'NVIDIA H100 80GB SXM5; ~700W TDP; datacenter colo' },
  { gpuSku: 'H200_141GB', gpuFamily: 'Hopper',     kwhDraw: 0.70, hardwarePriceUsd: 45000, bandwidthCostHourly: 0.30, notes: 'NVIDIA H200 141GB; same TDP as H100, larger HBM3e' },

  // Datacenter — Blackwell
  { gpuSku: 'B200_192GB', gpuFamily: 'Blackwell',  kwhDraw: 1.00, hardwarePriceUsd: 60000, bandwidthCostHourly: 0.35, notes: 'NVIDIA B200; ~1000W TDP at typical load' },
  { gpuSku: 'B300_288GB', gpuFamily: 'Blackwell',  kwhDraw: 1.10, hardwarePriceUsd: 70000, bandwidthCostHourly: 0.35, notes: 'NVIDIA B300 Ultra; +10% over B200' },
  { gpuSku: 'GB300',      gpuFamily: 'Blackwell',  kwhDraw: 1.50, hardwarePriceUsd: 95000, bandwidthCostHourly: 0.40, notes: 'NVIDIA Grace Blackwell GB300 superchip' },

  // Datacenter — Ada / Ampere
  { gpuSku: 'L40S_48GB',  gpuFamily: 'Ada',        kwhDraw: 0.35, hardwarePriceUsd: 9000,  bandwidthCostHourly: 0.20, notes: 'NVIDIA L40S; mid-tier datacenter inference/training' },
  { gpuSku: 'A100_80GB',  gpuFamily: 'Ampere',     kwhDraw: 0.40, hardwarePriceUsd: 15000, bandwidthCostHourly: 0.25, notes: 'NVIDIA A100 80GB SXM4 (common via customGpuModel)' },
  { gpuSku: 'A100_40GB',  gpuFamily: 'Ampere',     kwhDraw: 0.40, hardwarePriceUsd: 10000, bandwidthCostHourly: 0.25, notes: 'NVIDIA A100 40GB' },

  // Consumer
  { gpuSku: 'RTX_4090',   gpuFamily: 'Consumer',   kwhDraw: 0.45, hardwarePriceUsd: 1800,  bandwidthCostHourly: 0.02, notes: 'NVIDIA RTX 4090 24GB; residential/prosumer' },
  { gpuSku: 'RTX_3090',   gpuFamily: 'Consumer',   kwhDraw: 0.35, hardwarePriceUsd: 1500,  bandwidthCostHourly: 0.02, notes: 'NVIDIA RTX 3090 24GB; residential/prosumer' },

  // Tier defaults — fallback when declaredGpuSku is NULL. One per
  // GpuTier value so the cost-of-service service always finds a row.
  { gpuSku: 'TIER_DEFAULT_H100',     gpuFamily: 'Hopper',    kwhDraw: 0.70, hardwarePriceUsd: 30000, bandwidthCostHourly: 0.30, notes: 'Fallback when Node.gpuTier=H100 but declaredGpuSku is null' },
  { gpuSku: 'TIER_DEFAULT_H200',     gpuFamily: 'Hopper',    kwhDraw: 0.70, hardwarePriceUsd: 45000, bandwidthCostHourly: 0.30, notes: 'Fallback when Node.gpuTier=H200' },
  { gpuSku: 'TIER_DEFAULT_L40S',     gpuFamily: 'Ada',       kwhDraw: 0.35, hardwarePriceUsd: 9000,  bandwidthCostHourly: 0.20, notes: 'Fallback when Node.gpuTier=L40S' },
  { gpuSku: 'TIER_DEFAULT_B200',     gpuFamily: 'Blackwell', kwhDraw: 1.00, hardwarePriceUsd: 60000, bandwidthCostHourly: 0.35, notes: 'Fallback when Node.gpuTier=B200' },
  { gpuSku: 'TIER_DEFAULT_B300',     gpuFamily: 'Blackwell', kwhDraw: 1.10, hardwarePriceUsd: 70000, bandwidthCostHourly: 0.35, notes: 'Fallback when Node.gpuTier=B300' },
  { gpuSku: 'TIER_DEFAULT_GB300',    gpuFamily: 'Blackwell', kwhDraw: 1.50, hardwarePriceUsd: 95000, bandwidthCostHourly: 0.40, notes: 'Fallback when Node.gpuTier=GB300' },
  { gpuSku: 'TIER_DEFAULT_RTX_4090', gpuFamily: 'Consumer',  kwhDraw: 0.45, hardwarePriceUsd: 1800,  bandwidthCostHourly: 0.02, notes: 'Fallback when Node.gpuTier=RTX_4090' },
  { gpuSku: 'TIER_DEFAULT_RTX_3090', gpuFamily: 'Consumer',  kwhDraw: 0.35, hardwarePriceUsd: 1500,  bandwidthCostHourly: 0.02, notes: 'Fallback when Node.gpuTier=RTX_3090' },
  { gpuSku: 'TIER_DEFAULT_CONSUMER', gpuFamily: 'Consumer',  kwhDraw: 0.40, hardwarePriceUsd: 1600,  bandwidthCostHourly: 0.02, notes: 'Fallback when Node.gpuTier=CONSUMER (other RTX/AMD)' },
  { gpuSku: 'TIER_DEFAULT_OTHER',    gpuFamily: 'Other',     kwhDraw: 0.40, hardwarePriceUsd: 5000,  bandwidthCostHourly: 0.10, notes: 'Fallback when Node.gpuTier=OTHER (mid-range, unknown SKU)' },
]

const OVERHEAD_HOURLY = 0.05

async function main(): Promise<void> {
  console.log(`Seeding ${GPU_BASELINES.length} GpuCostBaseline rows + 1 PowerRate row...`)

  await prisma.powerRate.upsert({
    where: { region: 'GLOBAL' },
    create: {
      region: 'GLOBAL',
      usdPerKwh: GLOBAL_KWH_RATE,
      notes: 'Single global rate. Per-region rows added when M0.1+ wires region inference.',
    },
    update: {
      usdPerKwh: GLOBAL_KWH_RATE,
    },
  })
  console.log(`  PowerRate(GLOBAL) = $${GLOBAL_KWH_RATE}/kWh`)

  for (const seed of GPU_BASELINES) {
    const hardwareAmortHourly = seed.hardwarePriceUsd / HOURS_3YR
    const totalCostHourlyGlobal =
      seed.kwhDraw * GLOBAL_KWH_RATE +
      hardwareAmortHourly +
      seed.bandwidthCostHourly +
      OVERHEAD_HOURLY

    await prisma.gpuCostBaseline.upsert({
      where: { gpuSku: seed.gpuSku },
      create: {
        gpuSku: seed.gpuSku,
        gpuFamily: seed.gpuFamily,
        kwhDraw: seed.kwhDraw,
        hardwareAmortHourly,
        bandwidthCostHourly: seed.bandwidthCostHourly,
        overheadHourly: OVERHEAD_HOURLY,
        totalCostHourlyGlobal,
        notes: seed.notes,
      },
      update: {
        gpuFamily: seed.gpuFamily,
        kwhDraw: seed.kwhDraw,
        hardwareAmortHourly,
        bandwidthCostHourly: seed.bandwidthCostHourly,
        overheadHourly: OVERHEAD_HOURLY,
        totalCostHourlyGlobal,
        notes: seed.notes,
      },
    })
    console.log(`  ${seed.gpuSku.padEnd(26)} $${totalCostHourlyGlobal.toFixed(3)}/h  (kWh=${seed.kwhDraw}, amort=$${hardwareAmortHourly.toFixed(3)}, bw=$${seed.bandwidthCostHourly}, ovh=$${OVERHEAD_HOURLY})`)
  }

  console.log('Done.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
