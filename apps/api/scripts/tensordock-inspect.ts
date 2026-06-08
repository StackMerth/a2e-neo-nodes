/**
 * TensorDock read-only inspector.
 *
 * Sanity check after dropping TENSORDOCK_API_KEY into Render env. Lists
 * available GPU host inventory + your account's deployed VMs.
 *
 * TensorDock has TWO APIs in the wild:
 *   - Newer Core Cloud:  https://dashboard.tensordock.com/api/v0 (Bearer)
 *   - Legacy Marketplace: https://marketplace.tensordock.com/api/v0
 *     (api_key + api_token form fields)
 *
 * This script tries the Newer Core Cloud first. If it 401s and you have
 * a legacy key + token, set TENSORDOCK_API_TOKEN and we fall back to
 * legacy. The output flags which API responded.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts
 *     -> headline GPUs (H100/H200/A100/L40S/B200), sorted by price.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --raw
 *     -> full host catalog including consumer cards.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --gpu H100
 *     -> filter by GPU model substring (case-insensitive).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --vms
 *     -> list your account's currently-deployed VMs.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --probe
 *     -> just probe the auth path so we know which API your key targets.
 *
 * Aborts cleanly if TENSORDOCK_API_KEY is not set.
 */

const NEW_BASE = 'https://dashboard.tensordock.com/api/v0'
const LEGACY_BASE = 'https://marketplace.tensordock.com/api/v0'
const PRIORITY_TOKENS = ['H100', 'H200', 'A100', 'L40S', 'B200']

interface HostRow {
  host_id: string
  gpu_model: string
  gpu_count: number
  vram_per_gpu_gb?: number
  vcpus?: number
  ram_gb?: number
  storage_gb?: number
  location?: string
  price_per_hour_usd: number
  source: 'new' | 'legacy'
}

interface VmRow {
  id: string
  status: string
  gpu_model?: string
  gpu_count?: number
  ip?: string
  ssh_port?: number
  hourly_price?: number
}

class TensorDockClient {
  private apiKey: string
  private apiToken: string | null
  constructor() {
    this.apiKey = (process.env.TENSORDOCK_API_KEY ?? '').trim()
    const tok = (process.env.TENSORDOCK_API_TOKEN ?? '').trim()
    this.apiToken = tok || null
    if (!this.apiKey) throw new Error('TENSORDOCK_API_KEY missing.')
  }

  async probeAuth(): Promise<{ working: 'new' | 'legacy' | 'none'; detail: string }> {
    // Try Newer Core Cloud first.
    try {
      const res = await fetch(`${NEW_BASE}/billing`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      if (res.ok) return { working: 'new', detail: `Newer Core Cloud Bearer OK (HTTP ${res.status})` }
      if (res.status === 401 || res.status === 403) {
        // Try a list-hosts endpoint shape that's commonly documented.
        const res2 = await fetch(`${NEW_BASE}/hosts/list`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.apiKey}` },
        })
        if (res2.ok) return { working: 'new', detail: `Newer Bearer OK on /hosts/list (HTTP ${res2.status})` }
      }
    } catch (err) {
      // Network error; fall through to legacy.
    }

    if (!this.apiToken) {
      return {
        working: 'none',
        detail:
          'Newer Bearer rejected your TENSORDOCK_API_KEY. If you have a legacy api_token, set TENSORDOCK_API_TOKEN and re-run. Otherwise regenerate the key at dashboard.tensordock.com.',
      }
    }

    // Legacy api_key + api_token form-body shape.
    try {
      const res = await fetch(`${LEGACY_BASE}/client/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_key: this.apiKey, api_token: this.apiToken }).toString(),
      })
      if (res.ok) return { working: 'legacy', detail: `Legacy api_key+api_token OK (HTTP ${res.status})` }
      return { working: 'none', detail: `Legacy POST returned HTTP ${res.status}.` }
    } catch (err) {
      return {
        working: 'none',
        detail: `Both APIs failed. ${err instanceof Error ? err.message : err}`,
      }
    }
  }

  async listHostsNew(): Promise<HostRow[]> {
    const res = await fetch(`${NEW_BASE}/hosts/list`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Newer /hosts/list -> HTTP ${res.status}: ${body.slice(0, 300)}`)
    }
    const raw = (await res.json()) as unknown
    return normalizeNewHosts(raw)
  }

  async listHostsLegacy(): Promise<HostRow[]> {
    if (!this.apiToken) throw new Error('TENSORDOCK_API_TOKEN required for legacy listing.')
    const res = await fetch(`${LEGACY_BASE}/host/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: this.apiKey, api_token: this.apiToken }).toString(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Legacy /host/list -> HTTP ${res.status}: ${body.slice(0, 300)}`)
    }
    return normalizeLegacyHosts((await res.json()) as unknown)
  }

  async listVmsNew(): Promise<VmRow[]> {
    const res = await fetch(`${NEW_BASE}/virtualmachines/list`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Newer /virtualmachines/list -> HTTP ${res.status}: ${body.slice(0, 300)}`)
    }
    return normalizeNewVms((await res.json()) as unknown)
  }
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function normalizeNewHosts(raw: unknown): HostRow[] {
  // TensorDock Core Cloud /hosts/list response shape is documented as
  // { hosts: [ {id, gpu:{model, count, vram}, cpu:{cores}, ram, storage,
  // location, pricing:{gpuHourly}} ] }. Some catalog rows nest fields
  // differently. We try a few accessor patterns defensively.
  const out: HostRow[] = []
  const candidates = ((raw as { hosts?: unknown[] }).hosts ?? raw) as unknown[]
  if (!Array.isArray(candidates)) return out
  for (const c of candidates as Array<Record<string, unknown>>) {
    const gpuModel
      = asString(c.gpu_model)
      ?? asString((c.gpu as Record<string, unknown> | undefined)?.model)
      ?? asString(c.gpuModel)
      ?? '?'
    const gpuCount
      = asNumber(c.gpu_count)
      ?? asNumber((c.gpu as Record<string, unknown> | undefined)?.count)
      ?? asNumber(c.gpuCount)
      ?? 0
    const price
      = asNumber(c.price_per_hour_usd)
      ?? asNumber((c.pricing as Record<string, unknown> | undefined)?.gpuHourly)
      ?? asNumber(c.price)
      ?? 0
    out.push({
      host_id: asString(c.id) ?? asString(c.host_id) ?? '?',
      gpu_model: gpuModel,
      gpu_count: gpuCount,
      vram_per_gpu_gb:
        asNumber((c.gpu as Record<string, unknown> | undefined)?.vram)
        ?? asNumber(c.vram_per_gpu_gb),
      vcpus:
        asNumber((c.cpu as Record<string, unknown> | undefined)?.cores)
        ?? asNumber(c.vcpus),
      ram_gb: asNumber(c.ram) ?? asNumber(c.ram_gb),
      storage_gb: asNumber(c.storage) ?? asNumber(c.storage_gb),
      location: asString(c.location) ?? asString(c.region) ?? undefined,
      price_per_hour_usd: price,
      source: 'new',
    })
  }
  return out
}

function normalizeLegacyHosts(raw: unknown): HostRow[] {
  // Legacy marketplace.tensordock.com /host/list returns a per-host
  // nested catalog keyed by host_id. We flatten it into a per-GPU-model
  // row so the table reads consistently.
  const out: HostRow[] = []
  const root = (raw as Record<string, unknown>) ?? {}
  for (const [hostId, payload] of Object.entries(root)) {
    if (!payload || typeof payload !== 'object') continue
    const p = payload as Record<string, unknown>
    const gpus = (p.gpu as Record<string, unknown> | undefined) ?? {}
    const location = asString(p.location) ?? asString(p.region) ?? undefined
    for (const [model, slot] of Object.entries(gpus)) {
      if (!slot || typeof slot !== 'object') continue
      const s = slot as Record<string, unknown>
      const price = asNumber(s.price) ?? asNumber(s.price_per_hour) ?? 0
      out.push({
        host_id: hostId,
        gpu_model: model,
        gpu_count: asNumber(s.amount) ?? 0,
        vram_per_gpu_gb: asNumber(s.vram),
        vcpus: asNumber(p.cpu),
        ram_gb: asNumber(p.ram),
        storage_gb: asNumber(p.storage),
        location,
        price_per_hour_usd: price,
        source: 'legacy',
      })
    }
  }
  return out
}

function normalizeNewVms(raw: unknown): VmRow[] {
  const out: VmRow[] = []
  const candidates = ((raw as { virtualmachines?: unknown[] }).virtualmachines ?? raw) as unknown[]
  if (!Array.isArray(candidates)) return out
  for (const c of candidates as Array<Record<string, unknown>>) {
    out.push({
      id: asString(c.id) ?? '?',
      status: asString(c.status) ?? '?',
      gpu_model:
        asString(c.gpu_model)
        ?? asString((c.gpu as Record<string, unknown> | undefined)?.model),
      gpu_count:
        asNumber(c.gpu_count)
        ?? asNumber((c.gpu as Record<string, unknown> | undefined)?.count),
      ip: asString(c.ip) ?? asString(c.ipv4),
      ssh_port: asNumber(c.ssh_port),
      hourly_price: asNumber(c.hourly_price) ?? asNumber(c.price_per_hour),
    })
  }
  return out
}

async function main(): Promise<void> {
  if (!process.env.TENSORDOCK_API_KEY?.trim()) {
    console.log('TENSORDOCK_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at https://dashboard.tensordock.com')
    console.log('  2) Developer Settings -> generate API token')
    console.log('  3) Render -> a2e-api -> Environment -> add TENSORDOCK_API_KEY=<key>')
    console.log('  4) (legacy keys only) also add TENSORDOCK_API_TOKEN=<token>')
    console.log('  5) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const wantVms = args.includes('--vms')
  const wantProbe = args.includes('--probe')
  const gpuIdx = args.indexOf('--gpu')
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : undefined

  const client = new TensorDockClient()

  if (wantProbe) {
    const probe = await client.probeAuth()
    console.log(`Auth probe: ${probe.working}`)
    console.log(`  detail: ${probe.detail}`)
    return
  }

  if (wantVms) {
    console.log('Account virtual machines:')
    const vms = await client.listVmsNew()
    if (vms.length === 0) {
      console.log('  (none)')
      return
    }
    for (const v of vms) {
      const price = v.hourly_price !== undefined ? `$${v.hourly_price.toFixed(2)}/h` : ''
      const gpu = `${v.gpu_count ?? '?'}x ${v.gpu_model ?? '?'}`
      console.log(
        `  ${v.id.padEnd(36)} ${(v.status ?? '?').padEnd(14)} ${gpu.padEnd(32)} ${(v.ip ?? '-').padEnd(16)} ${price}`,
      )
    }
    return
  }

  console.log('Probing TensorDock auth...')
  const probe = await client.probeAuth()
  console.log(`  -> ${probe.working}: ${probe.detail}`)
  console.log()
  if (probe.working === 'none') {
    console.log('Cannot list hosts. Fix auth and re-run.')
    process.exit(1)
  }

  console.log(`Listing hosts via ${probe.working} API...`)
  const hosts = probe.working === 'new'
    ? await client.listHostsNew()
    : await client.listHostsLegacy()

  const filtered = (wantRaw || gpuArg)
    ? (gpuArg
      ? hosts.filter((h) => h.gpu_model.toUpperCase().includes(gpuArg.toUpperCase()))
      : hosts)
    : hosts.filter((h) =>
      PRIORITY_TOKENS.some((tok) => h.gpu_model.toUpperCase().includes(tok)),
    )

  const sorted = [...filtered].sort((a, b) => a.price_per_hour_usd - b.price_per_hour_usd)

  console.log(`Host catalog (${sorted.length} of ${hosts.length}${gpuArg ? `, gpu~${gpuArg}` : ''}):`)
  console.log()
  console.log(
    '  host_id'.padEnd(34)
    + 'gpu_model'.padEnd(30)
    + 'gpus'.padStart(5)
    + ' vram'.padEnd(7)
    + ' loc'.padEnd(8)
    + '  $/h',
  )
  for (const h of sorted) {
    const loc = (h.location ?? '?').padEnd(6)
    const vram = h.vram_per_gpu_gb !== undefined ? `${h.vram_per_gpu_gb}GB` : '?'
    const price = `$${h.price_per_hour_usd.toFixed(2)}`
    console.log(
      `  ${h.host_id.padEnd(32)}  ${h.gpu_model.padEnd(28)}  ${String(h.gpu_count).padStart(3)}x  ${vram.padEnd(5)}  ${loc} ${price.padStart(7)}`,
    )
  }
  console.log()
  console.log('Re-run with --raw to see consumer cards + non-priority tiers.')
  console.log('Re-run with --gpu <token> to filter (e.g. --gpu H200, --gpu rtxa4000).')
  console.log('Re-run with --vms to list your account virtual machines.')
}

main().catch((err) => {
  console.error(`tensordock-inspect failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
