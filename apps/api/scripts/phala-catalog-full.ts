/**
 * One-shot probe: dump Phala's FULL instance-type catalog including
 * both CPU TEE and GPU TEE SKUs with calculated 24h-minimum totals.
 *
 * The production `phala:inspect` script filters to GPU SKUs only
 * (since the platform only rents GPU CVMs to buyers). This probe
 * bypasses that filter to surface CPU TEE pricing, which is useful
 * for cheap adapter validation: testing the create/poll/terminate
 * flow against a sub-$25 CPU CVM instead of the $115 H200 GPU floor.
 *
 *   pnpm --filter @a2e/api phala:catalog
 *
 * Read-only. Calls GET /api/v1/instance-types directly. No state
 * mutation, no cost.
 */

interface RawInstanceItem {
  id: string
  name: string
  description: string
  vcpu: number
  memory_mb: number
  hourly_rate: string
  requires_gpu: boolean
  default_disk_size_gb: number
  family: string
}

interface RawGroup {
  name: string
  total: number
  items: RawInstanceItem[]
}

interface RawResponse {
  result: RawGroup[]
}

async function main(): Promise<void> {
  const apiKey = process.env.PHALA_API_KEY?.trim()
  if (!apiKey) {
    console.error('PHALA_API_KEY not set in environment.')
    console.error('On Render: shell -> tokenosdeai-api -> already injected.')
    console.error('Local: pull from Render env or set in .env first.')
    process.exit(1)
  }

  const base = process.env.PHALA_API_BASE?.trim() || 'https://cloud-api.phala.com/api/v1'
  const url = `${base.replace(/\/+$/, '')}/instance-types`

  console.log(`GET ${url}`)
  console.log()

  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey },
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`HTTP ${res.status}:`)
    console.error(text)
    process.exit(1)
  }

  const data = (await res.json()) as RawResponse

  if (!Array.isArray(data.result)) {
    console.error('Unexpected response shape (no result array):')
    console.error(JSON.stringify(data, null, 2))
    process.exit(1)
  }

  for (const group of data.result) {
    console.log(`=== ${group.name.toUpperCase()} (${group.total} SKUs) ===`)
    console.log()

    const sorted = [...group.items].sort(
      (a, b) => parseFloat(a.hourly_rate) - parseFloat(b.hourly_rate),
    )

    console.log(
      '  ' +
        'id'.padEnd(22) +
        'price/h'.padStart(9) +
        '  24h-min'.padStart(10) +
        '  vCPU'.padStart(6) +
        '     RAM'.padStart(10) +
        '   description',
    )
    for (const item of sorted) {
      const rate = parseFloat(item.hourly_rate ?? '0')
      const min24h = rate * 24
      const ramGb = Math.round((item.memory_mb ?? 0) / 1024)
      console.log(
        '  ' +
          item.id.padEnd(22) +
          `$${rate.toFixed(2)}`.padStart(9) +
          `   $${min24h.toFixed(2)}`.padStart(11) +
          String(item.vcpu ?? 0).padStart(6) +
          `${ramGb}GB`.padStart(10) +
          `   ${item.description ?? ''}`,
      )
    }
    console.log()
  }

  console.log('Notes:')
  console.log('  - 24h-min assumes Phala enforces 24h-minimum billing on the SKU.')
  console.log('  - Verify per-SKU minimum policy in Phala dashboard before relying on it.')
  console.log('  - CPU SKUs still get TDX (TEE-by-default) per Phala dashboard description.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
