/**
 * Read-only Hyperstack catalog inspector.
 *
 * Run locally to sanity-check before placing a portal rental:
 *   - Verifies HYPERSTACK_API_KEY works (lists environments)
 *   - Dumps the flavor catalog (every shape Hyperstack offers)
 *   - Filters by tier + count (shows what would match a buyer rental)
 *   - Shows the cheapest-available match per tier
 *
 * Usage (PowerShell, apps/api):
 *   $env:HYPERSTACK_API_KEY = "<key>"
 *   pnpm exec tsx scripts/hyperstack-inspect.ts
 *
 * Pass a tier as the first arg to filter the table to a single tier:
 *   pnpm exec tsx scripts/hyperstack-inspect.ts A100
 *   pnpm exec tsx scripts/hyperstack-inspect.ts H100 1
 *   pnpm exec tsx scripts/hyperstack-inspect.ts L40S 1
 *
 * This script does NOT provision anything. It's purely a read of the
 * Hyperstack catalog + environment list.
 */

import {
  HyperstackClient,
  findCheapestHyperstackFlavor,
  hyperstackPriceUsd,
  hyperstackTokenForTier,
} from '../src/services/inbound/hyperstack-adapter.js'
import type { GpuTier } from '@a2e/database'

const TIER_ARG = (process.argv[2] ?? '').toUpperCase()
const COUNT_ARG = process.argv[3] ? parseInt(process.argv[3], 10) : null

const KNOWN_TIERS: GpuTier[] = ['H100', 'H200', 'A100', 'L40S', 'B200']

async function main(): Promise<void> {
  if (!process.env.HYPERSTACK_API_KEY) {
    console.error('HYPERSTACK_API_KEY env var is required.')
    process.exit(1)
  }
  const client = new HyperstackClient()

  console.log('=== Hyperstack environments ===')
  try {
    const envs = await client.listEnvironments()
    if (envs.length === 0) {
      console.log('(none returned)')
    } else {
      for (const e of envs) {
        console.log(`  id=${e.id}  name=${e.name}  region=${e.region ?? '-'}`)
      }
    }
  } catch (err) {
    console.error('listEnvironments failed:', (err as Error).message)
    process.exit(1)
  }

  console.log('\n=== Hyperstack flavor catalog ===')
  let flavors
  try {
    flavors = await client.listFlavors()
  } catch (err) {
    console.error('listFlavors failed:', (err as Error).message)
    process.exit(1)
  }
  console.log(`(${flavors.length} flavors returned)`)
  if (flavors.length === 0) {
    console.log('No flavors. Either your account has no quota or the catalog is empty.')
    process.exit(0)
  }

  // /core/flavors does NOT surface cost_per_hour as of 2026-06-08, so
  // every row's `cost` falls back to 0. The cascade's STATIC_PRICES
  // table is the authoritative price. Print stock_available so the
  // operator can see what's actually rentable right now.
  const rows = flavors
    .map((f) => ({
      name: f.name,
      gpu: f.gpu ?? '-',
      gpu_count: f.gpu_count ?? 0,
      region: f.region_name ?? '-',
      cpu: f.cpu ?? 0,
      ram: f.ram ?? 0,
      disk: f.disk ?? 0,
      stock: f.stock_available === false ? 'OUT' : 'OK',
      cost: hyperstackPriceUsd(f.cost_per_hour),
    }))
    .sort((a, b) => {
      // Sort in-stock first, then by GPU type, then by count
      if (a.stock !== b.stock) return a.stock === 'OK' ? -1 : 1
      if (a.gpu !== b.gpu) return a.gpu.localeCompare(b.gpu)
      return a.gpu_count - b.gpu_count
    })

  for (const r of rows) {
    const priceCol = r.cost > 0 ? `$${r.cost.toFixed(2)}/h` : '(price: static)'
    console.log(
      `  [${r.stock}]  ${priceCol.padEnd(15)}  ${r.name.padEnd(28)} gpu=${r.gpu.padEnd(22)} x${r.gpu_count}  region=${r.region}  cpu=${r.cpu} ram=${r.ram}GB disk=${r.disk}GB`,
    )
  }

  console.log('\n=== Cheapest per A2E tier ===')
  const tiersToCheck: GpuTier[] = TIER_ARG && KNOWN_TIERS.includes(TIER_ARG as GpuTier)
    ? [TIER_ARG as GpuTier]
    : KNOWN_TIERS
  for (const tier of tiersToCheck) {
    const token = hyperstackTokenForTier(tier)
    if (!token) {
      console.log(`  ${tier}: tier_unmapped (no Hyperstack token defined)`)
      continue
    }
    const counts = COUNT_ARG ? [COUNT_ARG] : [1, 2, 4, 8]
    for (const count of counts) {
      try {
        const cheapest = await findCheapestHyperstackFlavor(client, tier, count)
        if (!cheapest) {
          console.log(`  ${tier} x${count}: no_supply (no matching flavor with cost > 0)`)
        } else {
          console.log(
            `  ${tier} x${count}: $${cheapest.pricePerHourUsd.toFixed(2)}/h  flavor=${cheapest.flavor.name}  region=${cheapest.flavor.region_name ?? '-'}`,
          )
        }
      } catch (err) {
        console.log(`  ${tier} x${count}: error - ${(err as Error).message}`)
      }
    }
  }

  console.log('\nDone. If cheapest-per-tier shows real prices + flavors, the cascade will route here.')
}

main().catch((err) => {
  console.error('hyperstack-inspect failed:', err)
  process.exit(1)
})
