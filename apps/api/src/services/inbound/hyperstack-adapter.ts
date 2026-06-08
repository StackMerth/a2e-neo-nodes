/**
 * Hyperstack REST adapter (inbound supply, direct).
 *
 * Why Hyperstack. Hyperstack (NexGen Cloud) is one of the upstream clouds
 * that Shadeform aggregates over. Going direct skips Shadeform's ~10-15%
 * markup AND gives us per-region control. We already validated their
 * VMs work end-to-end on 2026-06-08 via Shadeform routing (cmq5if3gr000
 * A100, cmq5j7msf000 H100; both delivered functional GPUs at
 * shadeform@<ip>:22).
 *
 * REST API.
 *   Base:    https://infrahub-api.nexgencloud.com/v1
 *   Auth:    api_key: <HYPERSTACK_API_KEY> header
 *   Docs:    https://infrahub-doc.nexgencloud.com
 *
 * The adapter wraps the subset we need to fulfill a buyer rental:
 *   - List flavors (the catalog of bookable instance shapes)
 *   - List environments (regions; needed on every create call)
 *   - Mint and delete SSH keypairs
 *   - Create / fetch / delete virtual machines
 *
 * Status mapping (Hyperstack -> our world).
 *   CREATING / BUILD / PROVISIONING / REBUILD       -> PENDING
 *   ACTIVE                                          -> ACTIVE
 *   ERROR                                           -> FAILED
 *   DELETING / DELETED                              -> CLOSED
 *
 * Configurability.
 *   HYPERSTACK_API_KEY              required for any live call
 *   HYPERSTACK_API_BASE             optional URL override
 *   HYPERSTACK_ALLOCATOR_ENABLED    'true'/'false'. Default true (master
 *                                   switch); flip false for surgical
 *                                   bypass when a Hyperstack incident
 *                                   makes routes flaky.
 *   HYPERSTACK_ENVIRONMENT          optional preferred region/environment
 *                                   name. Empty = pick the first
 *                                   environment that has the flavor
 *                                   available.
 */

import type { GpuTier } from '@a2e/database'

const DEFAULT_BASE_URL = 'https://infrahub-api.nexgencloud.com/v1'

export interface HyperstackFlavor {
  id: number
  name: string
  region_name?: string
  gpu?: string
  gpu_count?: number
  cpu?: number
  ram?: number
  disk?: number
  /** Hyperstack reports hourly price in USD as a string ("1.95") or number. */
  cost_per_hour?: string | number
}

export interface HyperstackEnvironment {
  id: number
  name: string
  region?: string
}

export interface HyperstackVm {
  id: number
  name: string
  status: HyperstackVmStatus
  /** Public IPv4 once provisioning completes; null until then. */
  floating_ip?: string | null
  /** Some Hyperstack responses return ip on the primary nic. */
  fixed_ip?: string | null
  flavor?: { name?: string }
  environment?: { name?: string }
  image?: { name?: string }
  /** SSH port from Hyperstack docs is 22 unless overridden; capture if surfaced. */
  ssh_port?: number | null
  created_at?: string
}

export type HyperstackVmStatus =
  | 'CREATING'
  | 'BUILD'
  | 'PROVISIONING'
  | 'REBUILD'
  | 'ACTIVE'
  | 'ERROR'
  | 'DELETING'
  | 'DELETED'
  | 'SHUTOFF'
  | string

export interface HyperstackCreateVmRequest {
  name: string
  environment_name: string
  image_name: string
  flavor_name: string
  key_name: string
  count?: number
  assign_floating_ip?: boolean
  user_data?: string
}

export class HyperstackApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `Hyperstack API ${endpoint} returned ${statusCode}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    )
    this.name = 'HyperstackApiError'
  }
}

export function isHyperstackConfigured(): boolean {
  return !!process.env.HYPERSTACK_API_KEY?.trim()
}

export function isHyperstackAllocatorEnabled(): boolean {
  // Default ON, matching the cascade master-switch philosophy. Set
  // HYPERSTACK_ALLOCATOR_ENABLED=false for surgical bypass.
  return process.env.HYPERSTACK_ALLOCATOR_ENABLED?.toLowerCase() !== 'false'
}

export function preferredHyperstackEnvironment(): string | null {
  const raw = process.env.HYPERSTACK_ENVIRONMENT?.trim()
  return raw ? raw : null
}

/**
 * Default image to deploy on Hyperstack VMs. Their catalog uses string
 * image names; "Ubuntu Server 22.04 LTS R570 CUDA 12.8 with Docker" is
 * the canonical GPU-ready Linux image as of 2026-06. Override via
 * HYPERSTACK_DEFAULT_IMAGE env if Hyperstack renames the SKU.
 */
export function hyperstackDefaultImage(): string {
  return process.env.HYPERSTACK_DEFAULT_IMAGE?.trim()
    || 'Ubuntu Server 22.04 LTS R570 CUDA 12.8 with Docker'
}

/**
 * Convert Hyperstack's cost-per-hour field (string OR number) into a
 * normalized USD float. Returns 0 for unparsable values so the probe
 * can fall back to STATIC_PRICES without throwing.
 */
export function hyperstackPriceUsd(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Internal-tier to Hyperstack GPU token map. Hyperstack flavors follow
 * patterns like:
 *   n3-h100-PCIe-80GB-1x, n3-h100-SXM5-80GB-1x, n3-h100-SXM5-80GB-8x
 *   n3-a100-80gb-1x, n3-a100-80gb-8x
 *   n3-l40-1x, n3-l40s-1x
 *   n3-rtx-a6000-1x
 *   n3-h200-SXM5-141GB-8x
 *   n3-b200-1x  (when rolled out)
 *
 * We match on the GPU substring in the flavor name; the probe picks the
 * cheapest variant matching the requested (tier, gpuCount).
 */
const GPU_TIER_TO_HYPERSTACK_TOKEN: Partial<Record<GpuTier, string>> = {
  H100: 'h100',
  H200: 'h200',
  A100: 'a100',
  L40S: 'l40s',
  B200: 'b200',
  // Hyperstack doesn't carry RTX 4090 / 3090 / consumer at any
  // meaningful scale; leave unmapped so the probe returns
  // tier_unmapped and the cascade falls through to Salad / Vast.ai.
}

export function hyperstackTokenForTier(tier: GpuTier): string | null {
  return GPU_TIER_TO_HYPERSTACK_TOKEN[tier] ?? null
}

export class HyperstackClient {
  private baseUrl: string
  private apiKey: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.HYPERSTACK_API_KEY)?.trim()
    if (!key) {
      throw new Error(
        'HyperstackClient requires HYPERSTACK_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.apiKey = key
    this.baseUrl = (baseUrl ?? process.env.HYPERSTACK_API_BASE ?? DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v)
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        api_key: this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      let parsed: unknown = await res.text()
      try {
        parsed = JSON.parse(parsed as string)
      } catch {
        // fall through with raw text
      }
      throw new HyperstackApiError(res.status, path, parsed)
    }
    // Hyperstack DELETE returns 204 No Content for VMs and 200 with body
    // for keypairs. Treat empty/whitespace bodies as {} so DELETE flows
    // don't fail after a successful operation.
    const text = await res.text()
    if (text.trim() === '') return {} as T
    return JSON.parse(text) as T
  }

  async listFlavors(opts?: { region?: string }): Promise<HyperstackFlavor[]> {
    const query: Record<string, string> = {}
    if (opts?.region) query.region = opts.region
    const res = await this.request<{ data?: HyperstackFlavor[]; flavors?: HyperstackFlavor[] }>(
      '/core/flavors',
      'GET',
      undefined,
      query,
    )
    // Hyperstack has shipped both `data` and `flavors` keys at various
    // points; accept either so we don't crash on a backend rename.
    return res.data ?? res.flavors ?? []
  }

  async listEnvironments(): Promise<HyperstackEnvironment[]> {
    const res = await this.request<{
      data?: HyperstackEnvironment[]
      environments?: HyperstackEnvironment[]
    }>('/core/environments', 'GET')
    return res.data ?? res.environments ?? []
  }

  async createKeypair(req: {
    name: string
    public_key: string
    environment_name: string
  }): Promise<{ id: number; name: string }> {
    const res = await this.request<{ data?: { id: number; name: string } }>(
      '/core/keypairs',
      'POST',
      req,
    )
    if (!res.data?.id) {
      throw new HyperstackApiError(
        500,
        '/core/keypairs',
        'createKeypair response missing data.id',
      )
    }
    return res.data
  }

  async deleteKeypair(id: number): Promise<void> {
    await this.request<unknown>(`/core/keypairs/${id}`, 'DELETE')
  }

  async createVm(req: HyperstackCreateVmRequest): Promise<HyperstackVm> {
    // Hyperstack returns { data: [vm, ...] } even for count=1; we always
    // request count=1 so the first element is ours.
    const res = await this.request<{ data?: HyperstackVm[] | HyperstackVm }>(
      '/core/virtual-machines',
      'POST',
      { ...req, count: req.count ?? 1, assign_floating_ip: req.assign_floating_ip ?? true },
    )
    const vm = Array.isArray(res.data) ? res.data[0] : res.data
    if (!vm) {
      throw new HyperstackApiError(
        500,
        '/core/virtual-machines',
        'createVm response missing data',
      )
    }
    return vm
  }

  async getVm(id: number): Promise<HyperstackVm> {
    const res = await this.request<{ data?: HyperstackVm; instance?: HyperstackVm }>(
      `/core/virtual-machines/${id}`,
      'GET',
    )
    const vm = res.data ?? res.instance
    if (!vm) {
      throw new HyperstackApiError(
        500,
        `/core/virtual-machines/${id}`,
        'getVm response missing data',
      )
    }
    return vm
  }

  async deleteVm(id: number): Promise<void> {
    await this.request<unknown>(`/core/virtual-machines/${id}`, 'DELETE')
  }
}

/**
 * Pick the cheapest Hyperstack flavor matching the requested (tier,
 * gpuCount). Filters by GPU name substring + GPU count match, then
 * sorts ascending by cost_per_hour. Returns null when nothing matches.
 */
export async function findCheapestHyperstackFlavor(
  client: HyperstackClient,
  tier: GpuTier,
  gpuCount: number,
): Promise<{ flavor: HyperstackFlavor; pricePerHourUsd: number } | null> {
  const token = hyperstackTokenForTier(tier)
  if (!token) return null

  let flavors: HyperstackFlavor[]
  try {
    flavors = await client.listFlavors()
  } catch {
    return null
  }

  const tokenUpper = token.toUpperCase()
  const matching = flavors.filter((f) => {
    const gpuLabel = (f.gpu ?? f.name ?? '').toUpperCase()
    if (!gpuLabel.includes(tokenUpper)) return false
    // Hyperstack flavor names embed the gpu_count as "...-Nx"; some rows
    // also surface gpu_count as a numeric field. Accept either.
    const count = f.gpu_count
      ?? extractGpuCountFromFlavorName(f.name)
      ?? 0
    return count === gpuCount
  })

  if (matching.length === 0) return null

  const sorted = matching
    .map((f) => ({ flavor: f, pricePerHourUsd: hyperstackPriceUsd(f.cost_per_hour) }))
    .filter((x) => x.pricePerHourUsd > 0)
    .sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)

  return sorted[0] ?? null
}

/**
 * Parse "n3-h100-PCIe-80GB-1x" -> 1, "n3-h100-SXM5-80GB-8x" -> 8. Returns
 * null when the trailing -Nx token isn't present. Defensive: Hyperstack
 * has shipped flavor names with and without the suffix.
 */
function extractGpuCountFromFlavorName(name: string | undefined): number | null {
  if (!name) return null
  const match = /-(\d+)x$/i.exec(name)
  if (!match) return null
  const parsed = parseInt(match[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Pick the first environment where the given flavor is provisionable.
 * If HYPERSTACK_ENVIRONMENT is set we honor it; otherwise we ask
 * Hyperstack which environments are returned in the flavor row's
 * region_name field. Falls back to the first listed environment when
 * none surface explicitly.
 */
export async function pickHyperstackEnvironment(
  client: HyperstackClient,
  flavor: HyperstackFlavor,
): Promise<string | null> {
  const preferred = preferredHyperstackEnvironment()
  if (preferred) return preferred
  if (flavor.region_name) return flavor.region_name
  try {
    const envs = await client.listEnvironments()
    return envs[0]?.name ?? null
  } catch {
    return null
  }
}
