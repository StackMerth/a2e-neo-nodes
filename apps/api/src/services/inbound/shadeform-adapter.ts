/**
 * Shadeform REST adapter (inbound supply, aggregator).
 *
 * Why Shadeform. Shadeform is a multi-cloud GPU aggregator that exposes
 * a single REST API over ~18 underlying GPU clouds (lambdalabs, crusoe,
 * hyperstack, latitude, denvr, voltagepark, scaleway, paperspace,
 * massedcompute, nebius, vultr, digitalocean, verda, imwt, horizon,
 * boostrun, amaya, excesssupply as of 2026-06-07). One adapter = ~18
 * networks of supply, often at prices cheaper than direct because
 * Shadeform negotiates wholesale rates.
 *
 * Aligns with the A2E supply-diversity principle: this adapter alone
 * triples the operator-facing supply pool. When Shadeform adds new
 * clouds to its aggregation, we get them automatically with zero env
 * or code changes.
 *
 * Real-world cheapest prices observed 2026-06-07 (post cents-to-dollar
 * normalization): latitude L40S $0.74/h, hyperstack A100_80G $1.35/h,
 * latitude H100_vm $1.66/h, digitalocean H200 $3.44/h, verda B200
 * $6.52/h. These beat several of our direct adapters.
 *
 * REST API.
 *   Base:    https://api.shadeform.ai/v1
 *   Auth:    X-API-KEY: <SHADEFORM_API_KEY>
 *   Docs:    https://docs.shadeform.ai
 *
 * Pricing format. Shadeform returns hourly_price in CENTS (integer).
 * Every consumer of this adapter must divide by 100 to get USD. The
 * helper centsToDollars() exists so no caller forgets.
 *
 * Status mapping (Shadeform -> our world).
 *   creating, pending_provider, pending -> PENDING
 *   active                              -> READY
 *   error                               -> FAILED
 *   deleting, deleted                   -> CLOSED
 *
 * Configurability.
 *   SHADEFORM_API_KEY              required for any live call
 *   SHADEFORM_API_BASE             optional URL override
 *   SHADEFORM_ALLOCATOR_ENABLED    'true'/'false'. Default true (master
 *                                  switch governed by the cascade
 *                                  philosophy: ship enabled, only flip
 *                                  off for surgical bypass).
 *   SHADEFORM_CLOUD_EXCLUDE        comma-separated cloud names to skip.
 *                                  Useful when an upstream cloud is
 *                                  parked (e.g. we want to keep direct
 *                                  Lambda + io.net relationships and
 *                                  exclude them from the Shadeform
 *                                  routing).
 */

import type { GpuTier } from '@a2e/database'

const DEFAULT_BASE_URL = 'https://api.shadeform.ai/v1'

export interface ShadeFormInstanceType {
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
  /** USD CENTS per hour (integer). Divide by 100 for dollars. */
  hourly_price?: number
  deployment_type?: string
  availability?: Array<{ region?: string; available?: boolean }>
  boot_time?: string
}

export interface ShadeFormCreateRequest {
  cloud: string
  region: string
  shade_instance_type: string
  shade_cloud: boolean
  name: string
  ssh_key_id?: string
  os?: string
  template_id?: string
  launch_configuration?: { type?: string; docker_configuration?: unknown }
  auto_delete?: { delete_after_seconds?: number }
}

export interface ShadeFormInstanceInfo {
  id: string
  cloud?: string
  region?: string
  shade_instance_type?: string
  status: ShadeFormInstanceStatus
  ip?: string | null
  ssh_user?: string | null
  ssh_port?: number | null
  hourly_price?: number
  created_at?: string
  deleted_at?: string | null
}

export type ShadeFormInstanceStatus =
  | 'creating'
  | 'pending_provider'
  | 'pending'
  | 'active'
  | 'error'
  | 'deleting'
  | 'deleted'

export class ShadeFormApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `Shadeform API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'ShadeFormApiError'
  }
}

export function isShadeFormConfigured(): boolean {
  return !!process.env.SHADEFORM_API_KEY?.trim()
}

export function isShadeFormAllocatorEnabled(): boolean {
  // Default ON, matching the cascade master-switch philosophy. Set
  // SHADEFORM_ALLOCATOR_ENABLED=false for surgical bypass (e.g. when
  // an upstream Shadeform incident makes routes flaky and you want to
  // force the cascade onto direct adapters temporarily).
  return process.env.SHADEFORM_ALLOCATOR_ENABLED?.toLowerCase() !== 'false'
}

/**
 * Clouds the operator wants to exclude from Shadeform routing.
 * Set SHADEFORM_CLOUD_EXCLUDE=lambdalabs,crusoe to keep direct
 * relationships with those vendors and only let Shadeform fill the
 * long tail (latitude, hyperstack, verda, etc.). Defaults to empty.
 */
export function getShadeFormExcludedClouds(): Set<string> {
  const raw = process.env.SHADEFORM_CLOUD_EXCLUDE?.trim() ?? ''
  if (!raw) return new Set()
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
}

export function centsToDollars(cents: number | undefined): number {
  if (cents === undefined || !Number.isFinite(cents)) return 0
  return cents / 100
}

/**
 * Internal-tier to Shadeform GPU type substring map. Shadeform's
 * shade_instance_type strings follow patterns like:
 *   H100, H100_sxm5, H100_nvl, H100_pcie
 *   H200, H200_sxm5
 *   A100, A100_80G, A100_sxm4, A100_sxm4_80G, A100_sxm4_80G_DGX
 *   L40S, L40s_vm
 *   B200, B200_sxm6
 *   RTX_4090, RTX_3090 (when present)
 *
 * We filter by the leading token; the search returns every variant
 * matching that prefix across every aggregated cloud. The probe picks
 * the cheapest available row.
 *
 * GB300 not yet observed in the Shadeform catalog; left unmapped so
 * the probe returns tier_unmapped instead of false positives.
 */
const GPU_TIER_TO_SHADEFORM_TOKEN: Partial<Record<GpuTier, string>> = {
  H100: 'H100',
  H200: 'H200',
  A100: 'A100',
  L40S: 'L40S',
  B200: 'B200',
  // B300 / GB300 not in Shadeform catalog as of 2026-06-07; verify on
  // next inspector pass before adding entries.
  RTX_4090: 'RTX_4090',
  RTX_3090: 'RTX_3090',
}

export function shadeFormTokenForTier(tier: GpuTier): string | null {
  return GPU_TIER_TO_SHADEFORM_TOKEN[tier] ?? null
}

export class ShadeFormClient {
  private baseUrl: string
  private apiKey: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.SHADEFORM_API_KEY)?.trim()
    if (!key) {
      throw new Error(
        'ShadeFormClient requires SHADEFORM_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.apiKey = key
    this.baseUrl = (baseUrl ?? process.env.SHADEFORM_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
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
        'X-API-KEY': this.apiKey,
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
      throw new ShadeFormApiError(res.status, path, parsed)
    }
    // Some Shadeform endpoints (e.g. /instances/{id}/delete,
    // /sshkeys/{id}/delete) return 200 with an empty body. JSON.parse
    // on an empty string throws "Unexpected end of JSON input". Treat
    // empty/whitespace-only bodies as {} so DELETE calls don't fail
    // after a successful operation.
    const text = await res.text()
    if (text.trim() === '') return {} as T
    return JSON.parse(text) as T
  }

  async listInstanceTypes(opts?: {
    cloud?: string
    gpu_type?: string
    num_gpus?: number
    available?: boolean
  }): Promise<ShadeFormInstanceType[]> {
    const query: Record<string, string> = {}
    if (opts?.cloud) query.cloud = opts.cloud
    if (opts?.gpu_type) query.gpu_type = opts.gpu_type
    if (opts?.num_gpus !== undefined) query.num_gpus = String(opts.num_gpus)
    if (opts?.available !== undefined) query.available = String(opts.available)
    const res = await this.request<{ instance_types?: ShadeFormInstanceType[] }>(
      '/instances/types',
      'GET',
      undefined,
      query,
    )
    return res.instance_types ?? []
  }

  async getInstance(id: string): Promise<ShadeFormInstanceInfo> {
    return await this.request<ShadeFormInstanceInfo>(`/instances/${id}/info`, 'GET')
  }

  async createInstance(req: ShadeFormCreateRequest): Promise<{ id: string; status: ShadeFormInstanceStatus }> {
    return await this.request<{ id: string; status: ShadeFormInstanceStatus }>(
      '/instances/create',
      'POST',
      req,
    )
  }

  async deleteInstance(id: string): Promise<void> {
    await this.request<unknown>(`/instances/${id}/delete`, 'POST')
  }

  /**
   * Register an SSH public key with Shadeform; returns the key id we
   * pass to /instances/create as ssh_key_id. Per their docs:
   *   POST /sshkeys/add  body: { name, public_key }  -> { id }
   * Shadeform's managed SSH key is the system default; we add our
   * per-rental key alongside it.
   */
  async addSshKey(req: { name: string; public_key: string }): Promise<{ id: string }> {
    return await this.request<{ id: string }>('/sshkeys/add', 'POST', req)
  }

  /**
   * Idempotent: Shadeform requires unique key names. We pass the
   * computeRequestId-derived label so the same rental never collides.
   */
  async deleteSshKey(id: string): Promise<void> {
    await this.request<unknown>(`/sshkeys/${id}/delete`, 'POST')
  }
}

/**
 * Cheapest available Shadeform row for a (tier, count) pair, after
 * applying the operator's cloud-exclusion filter. Returns null when
 * Shadeform has no supply matching the request. Pricing comes back in
 * USD per hour (already converted from cents).
 */
export async function findCheapestShadeFormType(
  client: ShadeFormClient,
  tier: GpuTier,
  gpuCount: number,
): Promise<{ type: ShadeFormInstanceType; pricePerHourUsd: number } | null> {
  const token = shadeFormTokenForTier(tier)
  if (!token) return null

  const excluded = getShadeFormExcludedClouds()
  // Fetch unfiltered then filter client-side: Shadeform's gpu_type
  // filter is enum-strict and we don't want to brittle-couple to their
  // exact strings. The catalog is ~270 rows, well under any rate limit
  // concern.
  let types: ShadeFormInstanceType[]
  try {
    types = await client.listInstanceTypes({ available: true })
  } catch {
    return null
  }

  const matching = types.filter((t) => {
    if (excluded.has(t.cloud?.toLowerCase() ?? '')) return false
    const gpuLabel = (t.configuration?.gpu_type ?? t.shade_instance_type ?? '').toUpperCase()
    if (!gpuLabel.includes(token.toUpperCase())) return false
    const num = t.configuration?.num_gpus ?? 0
    return num === gpuCount
  })

  if (matching.length === 0) return null

  const sorted = matching
    .map((t) => ({ type: t, pricePerHourUsd: centsToDollars(t.hourly_price) }))
    .filter((x) => x.pricePerHourUsd > 0)
    .sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)

  return sorted[0] ?? null
}
