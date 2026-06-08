/**
 * Shadeform read-only inspector.
 *
 * Sanity check after dropping SHADEFORM_API_KEY into Render env. Lists
 * available GPU instance types across every cloud Shadeform aggregates,
 * plus your account's current instances.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-inspect.ts
 *     -> headline GPUs (H100 / H200 / A100 / L40S / B200) across all clouds,
 *        sorted by price ascending.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-inspect.ts --raw
 *     -> full catalog including consumer cards.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-inspect.ts --gpu H100
 *     -> filter by GPU type (case-insensitive substring).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-inspect.ts --cloud lambda
 *     -> filter by underlying cloud provider.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-inspect.ts --instances
 *     -> list your current Shadeform-managed instances.
 *
 * Aborts cleanly if SHADEFORM_API_KEY is not set.
 *
 * Shadeform API ref: https://docs.shadeform.ai
 *   Base: https://api.shadeform.ai/v1
 *   Auth: X-API-KEY header
 */

const BASE_URL = 'https://api.shadeform.ai/v1'
const PRIORITY_TOKENS = ['H100', 'H200', 'A100', 'L40S', 'B200']

interface InstanceType {
  cloud: string
  shade_instance_type: string
  cloud_instance_type: string
  configuration?: {
    gpu_type?: string
    num_gpus?: number
    vcpus?: number
    memory_in_gb?: number
    storage_in_gb?: number
  }
  hourly_price?: number
  deployment_type?: string
  availability?: Array<{ region?: string; available?: boolean }>
  boot_time?: string
}

interface InstanceInfo {
  id: string
  cloud: string
  region?: string
  shade_instance_type?: string
  status: string
  ip?: string
  hourly_price?: number
  created_at?: string
}

async function shadeformGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const key = process.env.SHADEFORM_API_KEY?.trim()
  if (!key) throw new Error('SHADEFORM_API_KEY missing.')
  const url = new URL(`${BASE_URL}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'X-API-KEY': key },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

function isPriorityType(t: InstanceType): boolean {
  const haystack = (t.configuration?.gpu_type ?? t.shade_instance_type ?? '').toUpperCase()
  return PRIORITY_TOKENS.some((tok) => haystack.includes(tok))
}

async function listInstanceTypes(opts: { cloud?: string; gpu?: string; available?: boolean }): Promise<InstanceType[]> {
  const params: Record<string, string> = {}
  if (opts.cloud) params.cloud = opts.cloud
  if (opts.gpu) params.gpu_type = opts.gpu
  if (opts.available !== undefined) params.available = String(opts.available)
  const res = await shadeformGet<{ instance_types?: InstanceType[] }>('/instances/types', params)
  return res.instance_types ?? []
}

async function listInstances(): Promise<InstanceInfo[]> {
  const res = await shadeformGet<{ instances?: InstanceInfo[] }>('/instances')
  return res.instances ?? []
}

async function main(): Promise<void> {
  if (!process.env.SHADEFORM_API_KEY?.trim()) {
    console.log('SHADEFORM_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at https://www.shadeform.ai (free trial available)')
    console.log('  2) Settings -> API keys -> create a key')
    console.log('  3) Render -> a2e-api -> Environment -> add SHADEFORM_API_KEY=<key>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const wantInstances = args.includes('--instances')
  const gpuIdx = args.indexOf('--gpu')
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : undefined
  const cloudIdx = args.indexOf('--cloud')
  const cloudArg = cloudIdx >= 0 ? args[cloudIdx + 1] : undefined

  if (wantInstances) {
    console.log('Account instances:')
    const inst = await listInstances()
    if (inst.length === 0) {
      console.log('  (none)')
      return
    }
    for (const i of inst) {
      const price = i.hourly_price !== undefined ? `$${i.hourly_price.toFixed(2)}/h` : ''
      console.log(
        `  ${i.id.padEnd(36)} ${(i.cloud ?? '').padEnd(14)} ${(i.shade_instance_type ?? '').padEnd(28)} ${(i.status ?? '').padEnd(14)} ${(i.ip ?? '-').padEnd(16)} ${price}`,
      )
    }
    return
  }

  console.log('Calling Shadeform /instances/types ...')
  console.log()
  const allTypes = await listInstanceTypes({ cloud: cloudArg, gpu: gpuArg })

  // Sort cheapest first when price is present; types without a price
  // sink to the bottom so the headline output stays useful.
  const sorted = [...allTypes].sort((a, b) => {
    const ap = a.hourly_price ?? Number.POSITIVE_INFINITY
    const bp = b.hourly_price ?? Number.POSITIVE_INFINITY
    return ap - bp
  })

  const filtered = wantRaw || gpuArg ? sorted : sorted.filter(isPriorityType)

  console.log(
    `Instance types (${filtered.length} of ${sorted.length}${gpuArg ? `, filtered by gpu=${gpuArg}` : ''}${cloudArg ? `, cloud=${cloudArg}` : ''}):`,
  )
  console.log()
  console.log(
    '  cloud'.padEnd(14)
    + 'shade_instance_type'.padEnd(36)
    + 'cloud_instance_type'.padEnd(28)
    + 'gpus'.padStart(5)
    + ' vram'.padEnd(7)
    + ' $/h'.padEnd(9)
    + 'available_regions',
  )

  const cloudSet = new Set<string>()
  for (const t of filtered) {
    cloudSet.add(t.cloud)
    const gpus = t.configuration?.num_gpus ?? 0
    const gpu = t.configuration?.gpu_type ?? '?'
    // Shadeform returns hourly_price in CENTS. Divide by 100 to display
    // USD so the inspector matches what the adapter actually charges.
    const priceUsd = t.hourly_price !== undefined ? t.hourly_price / 100 : null
    const price = priceUsd !== null ? `$${priceUsd.toFixed(2)}` : '-'
    const regions = (t.availability ?? [])
      .filter((a) => a.available !== false && a.region)
      .map((a) => a.region)
      .slice(0, 4)
      .join(',')
    const moreRegions = (t.availability ?? []).length > 4 ? '+...' : ''
    console.log(
      `  ${(t.cloud ?? '').padEnd(12)}  ${t.shade_instance_type.padEnd(34)}  ${t.cloud_instance_type.padEnd(26)}  ${String(gpus).padStart(3)}x  ${gpu.padEnd(8)} ${price.padStart(7)}/h  ${regions}${moreRegions}`,
    )
  }
  console.log()
  console.log(`Underlying clouds aggregated: ${[...cloudSet].sort().join(', ') || '(none)'}`)
  console.log()
  console.log('Re-run with --raw to see consumer cards + non-priority tiers.')
  console.log('Re-run with --gpu <token> to filter by GPU substring (e.g. --gpu H200).')
  console.log('Re-run with --cloud <name> to filter by underlying cloud (e.g. --cloud lambdalabs).')
  console.log('Re-run with --instances to list your account instances.')
}

main().catch((err) => {
  console.error(`shadeform-inspect failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
