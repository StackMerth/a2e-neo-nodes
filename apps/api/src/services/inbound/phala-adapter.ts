/**
 * T5f / Phase 1 — Phala Network Cloud API adapter (inbound supply,
 * confidential GPU compute).
 *
 * Third inbound provider after Lambda + RunPod. Phala is the platform's
 * answer to the original testers' requirement for Intel TDX + AMD SEV-
 * SNP confidential compute on H100/H200 GPUs. Unlike Lambda + RunPod
 * which serve standard (non-confidential) workloads, every Phala CVM
 * is a confidential VM — the buyer's code + data are protected from
 * the host kernel + other tenants via hardware TEE.
 *
 * SCAFFOLD STATUS (2026-06-02): This file is the initial structure.
 * Field names and endpoint paths are based on Phala Cloud's
 * documented patterns at https://docs.phala.network and may need
 * correction once we observe real API responses. We expect a
 * similar discovery process to RunPod (where /gputypes turned out
 * to not exist on REST and we had to switch to GraphQL).
 *
 * Verification path before going live:
 *   1. USER sets PHALA_API_KEY in Render env (see milestone 1.1)
 *   2. USER runs `pnpm --filter @a2e/api phala:inspect` (TBD)
 *   3. We compare actual API response shapes to the types below
 *   4. Adjust field mappings as needed
 *   5. ONLY after listGpuTypes + getCvm both work, attempt createCvm
 *
 * Tenancy model differs from Lambda/RunPod:
 *   - Every Phala CVM is dedicated (confidential VM is single-tenant
 *     by definition; you can't multi-tenant a TDX/SEV-SNP guest)
 *   - No COMMUNITY vs SECURE tier split like RunPod
 *   - Pricing is per-CVM-hour; bigger CVMs cost more proportionally
 *
 * Confidential compute primitives Phala exposes:
 *   - Intel TDX (CPU-side trust domain isolation)
 *   - AMD SEV-SNP (memory encryption)
 *   - NVIDIA H100 Confidential Computing mode (GPU-side attestation)
 *   - Attestation reports (RA-TLS) for end-to-end verification —
 *     buyer's code can verify it's actually running in a TEE before
 *     unsealing keys / secrets. NOT surfaced through our adapter
 *     in Phase 1; that's a Phase 1.8+ enhancement.
 *
 * Payment model:
 *   - PHA token (Phala's native) OR USDC supported per their API
 *   - This adapter currently assumes USDC settlement (simpler — no
 *     bridging required). PHA support is a Phase 2 enhancement.
 *   - Cost is charged to our Phala account; we mark up + bill the
 *     buyer's TokenOS balance via existing per-minute-meter.
 */

// Verified against Phala's OpenAPI spec at https://docs.phala.com/openapi.json
// (2026-06-02). The host is `cloud-api.phala.com` (NOT phala.network — that
// returns nginx 404). All endpoints live under /api/v1/.
const DEFAULT_BASE_URL = 'https://cloud-api.phala.com/api/v1'

/**
 * The Phala CVM model is Docker Compose-driven, not single-image.
 * We import the default compose template from phala-default-compose.ts
 * and pass it in createCvm. Buyers wanting custom workloads can pass
 * their own compose via the provisioning orchestrator options later
 * (Path B / advanced — deferred per architecture decision).
 */
import { buildDefaultPhalaCompose } from './phala-default-compose.js'
export { PHALA_DEFAULT_BASE_IMAGE } from './phala-default-compose.js'

export class PhalaApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `Phala API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'PhalaApiError'
  }
}

/**
 * Phala GPU instance type. Phala calls these "CVM templates" or
 * "GPU CVM SKUs" depending on which doc you read. Subject to
 * verification against the live /gpu-types or /templates endpoint.
 */
export interface PhalaGpuType {
  id: string
  /** Human-readable label e.g. "H100 80GB Confidential". */
  displayName: string
  /** GPU model: H100, H200, B200 etc. */
  gpuModel: string
  /** Memory per GPU in GiB. */
  memoryInGb: number
  /** Per-hour price in USD (Phala converts PHA → USD if needed). */
  pricePerHourUsd: number
  /** TEE primitives this SKU supports (TDX / SEV-SNP / both). */
  teeSupport: Array<'TDX' | 'SEV-SNP'>
  /** Whether Phala reports stock available right now. */
  hasCurrentStock: boolean
}

export type PhalaCvmStatus =
  | 'CREATING'   // Phala is allocating hardware
  | 'STARTING'   // VM is booting
  | 'RUNNING'    // SSH listening; buyer can connect
  | 'STOPPING'   // Termination in progress
  | 'STOPPED'    // Stopped but still allocated (resumable)
  | 'TERMINATED' // Fully released, no further billing

export interface PhalaCvm {
  id: string
  name: string | null
  status: PhalaCvmStatus
  gpuTypeId: string
  gpuCount: number
  region: string | null
  /** Public IP for SSH. Populated when status=RUNNING. */
  publicIp: string | null
  /** Public TCP port mapped to container's port 22. */
  sshPort: number | null
  pricePerHourUsd: number | null
  /** Attestation report URL (Phase 1.8+ surface). */
  attestationReportUrl: string | null
  createdAt: string | null
}

export interface CreateCvmArgs {
  name: string
  gpuTypeId: string
  gpuCount: number
  /** SSH public key (openssh format) the CVM entrypoint injects. */
  sshPublicKey: string
  /** Override the default CVM image. Must include openssh-server. */
  imageName?: string
  /** Container scratch disk in GB. Default 50. */
  containerDiskInGb?: number
  /** Required TEE: 'TDX', 'SEV-SNP', or 'ANY' (Phala picks). */
  teeMode?: 'TDX' | 'SEV-SNP' | 'ANY'
}

export function isPhalaConfigured(): boolean {
  return Boolean(process.env.PHALA_API_KEY?.trim())
}

export class PhalaClient {
  private readonly base: string
  private readonly apiKey: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.PHALA_API_KEY ?? '').trim()
    if (!key) {
      throw new Error(
        'PhalaClient requires PHALA_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.base = (baseUrl ?? process.env.PHALA_API_BASE ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
    // Canonical auth scheme verified 2026-06-02 via empirical curl
    // test: X-API-Key header works (HTTP 200), Bearer returns 401
    // "Invalid or expired token". Bearer is reserved for Phala's
    // OAuth2 user-session flow; project API keys (phak_...) only
    // authenticate via X-API-Key.
    this.apiKey = key
  }

  /**
   * Catalog of available instance types Phala offers. Response shape
   * verified 2026-06-02:
   *
   *   {
   *     result: [
   *       { name: "cpu", items: [{ id: "tdx.small", ... }], total: 7 },
   *       { name: "gpu", items: [{ id: "h200.small", ... }], total: 3 },
   *     ]
   *   }
   *
   * Every instance has TDX baked in (per description text). Filter
   * to GPU family only; the platform never rents CPU CVMs to buyers.
   *
   * Real items currently available on Phala (2026-06-02):
   *   - h200.small     1x H200, 24 vCPU, 256GB RAM        $4.80/h
   *   - h200.16xlarge  8x H200, 24 vCPU, 128GB RAM        $32.00/h (low CPU)
   *   - h200.8x.large  8x H200, 192 vCPU, 1.5TB RAM       $32.00/h (full CPU/RAM)
   *
   * No H100 / B200 / L40S yet on Phala. Tier mapping reflects this
   * (only H200 entries; other tiers skip Phala in the cascade).
   */
  async listGpuTypes(): Promise<PhalaGpuType[]> {
    const raw = await this.request<RawInstanceTypesResponse>('/instance-types', 'GET')
    const gpuGroup = raw.result?.find((g) => g.name === 'gpu')
    if (!gpuGroup) return []
    return gpuGroup.items.map((t) => ({
      id: t.id,
      displayName: t.name ?? t.id,
      gpuModel: parseGpuModel(t.id, t.name),
      memoryInGb: Math.round((t.memory_mb ?? 0) / 1024),
      pricePerHourUsd: parseFloat(t.hourly_rate ?? '0'),
      // All Phala instances support TDX per their dashboard
      // description; SEV-SNP isn't explicitly surfaced per SKU but
      // is supported on their hardware fleet broadly. Default to
      // both until we find a SKU that's TDX-only.
      teeSupport: ['TDX', 'SEV-SNP'],
      // Phala doesn't surface per-instance live capacity in this
      // endpoint. If a SKU is in the catalog, treat it as orderable
      // and let createCvm return 409 / 503 if all nodes are busy.
      hasCurrentStock: true,
    }))
  }

  /**
   * List every CVM currently allocated on the account. Used by the
   * inspector + orphan reconciler.
   */
  async listCvms(): Promise<PhalaCvm[]> {
    const raw = await this.request<RawCvmResponse[]>('/cvms', 'GET')
    return raw.map(normalizeCvm)
  }

  /**
   * Poll a specific CVM during the boot window. The poll worker
   * wakes every ~10s while a rental is PENDING and waits for
   * status=RUNNING + publicIp + sshPort.
   */
  async getCvm(id: string): Promise<PhalaCvm> {
    const raw = await this.request<RawCvmResponse>(
      `/cvms/${encodeURIComponent(id)}`,
      'GET',
    )
    return normalizeCvm(raw)
  }

  /**
   * Create + start a GPU CVM and begin billing. Per the OpenAPI spec
   * the GPU-specific endpoint is /cvms/workload which auto-selects a
   * node from available resources (no separate node-picking step
   * unlike Lambda's region selection).
   *
   * Confidential VMs typically take longer to boot than standard
   * pods (TEE attestation handshake adds ~30-60s) — expect ~90-180s
   * before RUNNING.
   *
   * Phala's CVM model is Docker Compose-based. We pass our default
   * Compose template (SSH + CUDA + PUBLIC_KEY injection) so the
   * buyer's UX matches Lambda/RunPod rentals — they SSH in after the
   * CVM reaches RUNNING. Compose template lives in
   * phala-default-compose.ts and is built in Milestone 1.4.
   */
  async createCvm(args: CreateCvmArgs): Promise<string> {
    // Build the default SSH+CUDA Compose so the buyer's UX matches
    // Lambda/RunPod (they SSH in). Custom-image override flows
    // through to the compose builder; advanced "bring your own
    // compose" path is a deferred Path B option.
    const compose = buildDefaultPhalaCompose({
      imageName: args.imageName,
      containerDiskInGb: args.containerDiskInGb,
    })

    // Body shape is BEST-GUESS based on common Compose-deploy API
    // conventions (Phala's OpenAPI CreateWorkloadTappRequest schema
    // is in the truncated binary section). The first real createCvm
    // call will return a 422 with the actual required field names;
    // we adjust those mappings then. Fields likely needed:
    //   name (or display_name)
    //   instance_type_id (or instance_type) — e.g. "h200.small"
    //   compose_file (string YAML) or docker_compose (object)
    //   env (object) — PUBLIC_KEY for SSH bootstrap
    //   disk_size_gb (override of default_disk_size_gb from SKU)
    //
    // Sending both naming conventions until validation tells us which
    // wins. Better than nothing for the first attempt.
    const body = {
      name: args.name,
      // Most likely field name based on REST conventions:
      instance_type_id: args.gpuTypeId,
      // Backup naming Phala may use:
      instance_type: args.gpuTypeId,
      gpu_count: args.gpuCount,
      compose_file: compose,
      env: {
        PUBLIC_KEY: args.sshPublicKey,
      },
      ...(args.containerDiskInGb !== undefined
        ? { disk_size_gb: args.containerDiskInGb }
        : {}),
    }
    const raw = await this.request<{ id: string }>('/cvms/workload', 'POST', body)
    return raw.id
  }

  /**
   * Stop a CVM. Phala distinguishes STOP (pause, keep allocation)
   * from TERMINATE (full release). For our rental model we always
   * want TERMINATE to stop billing fully.
   */
  async terminateCvm(id: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/cvms/${encodeURIComponent(id)}`,
        'DELETE',
      )
    } catch (err) {
      if (err instanceof PhalaApiError && err.statusCode === 404) return
      throw err
    }
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        // X-API-Key is the canonical auth header for Phala project
        // API keys (verified 2026-06-02 — Bearer returns 401).
        'X-API-Key': this.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    if (!res.ok) {
      throw new PhalaApiError(res.status, path, parsed ?? text)
    }
    return parsed as T
  }
}

// Raw response shapes — subject to verification against real API.
// Field names are best-guess from Phala docs and may differ.

// Verified response shape from GET /api/v1/instance-types (2026-06-02):
// { result: [ { name: "cpu"|"gpu", items: [...], total: N } ] }
interface RawInstanceTypesResponse {
  result: Array<{
    name: 'cpu' | 'gpu'
    items: RawInstanceTypeItem[]
    total: number
  }>
}

interface RawInstanceTypeItem {
  id: string                       // e.g. "h200.small", "h200.16xlarge"
  name: string                     // e.g. "H200 SXM 141GB"
  description: string              // "H200 SXM (141 GB VRAM), 24 vCPU, 256GB RAM with TDX support"
  vcpu: number
  memory_mb: number
  hourly_rate: string              // String! e.g. "4.800000"
  requires_gpu: boolean
  default_disk_size_gb: number
  family: 'cpu' | 'gpu'
}

/** Map Phala's instance id to the underlying GPU model name. */
function parseGpuModel(id: string, name: string): string {
  // ids look like "h200.small", "h200.16xlarge". Take everything
  // before the first "." and upper-case (e.g. H200, H100, B200).
  const prefix = (id.split('.')[0] ?? '').toUpperCase()
  if (prefix) return prefix
  // Fallback: parse from the human name field.
  const match = name.match(/(H100|H200|B200|B300|A100|L40S|RTX\s*\d+)/i)
  if (match && match[1]) return match[1].toUpperCase().replace(/\s+/g, '')
  return 'unknown'
}

interface RawCvmResponse {
  id: string
  name?: string
  status?: PhalaCvmStatus
  gpuTypeId?: string
  gpuCount?: number
  region?: string
  publicIp?: string
  sshPort?: number
  pricePerHourUsd?: number
  attestationReportUrl?: string
  createdAt?: string
  ports?: Array<{ privatePort?: number; publicPort?: number; ip?: string }>
}

function normalizeCvm(raw: RawCvmResponse): PhalaCvm {
  // SSH port: same pattern as RunPod — find the entry mapping port 22
  // to a public port. Confidential CVMs may not surface this until
  // attestation completes, so PENDING pods get sshPort=null.
  let sshPort: number | null = raw.sshPort ?? null
  let publicIp: string | null = raw.publicIp ?? null
  if (sshPort === null && Array.isArray(raw.ports)) {
    const sshEntry = raw.ports.find((p) => p.privatePort === 22 && typeof p.publicPort === 'number')
    if (sshEntry) {
      sshPort = sshEntry.publicPort ?? null
      if (!publicIp && typeof sshEntry.ip === 'string') publicIp = sshEntry.ip
    }
  }
  return {
    id: raw.id,
    name: raw.name ?? null,
    status: raw.status ?? 'CREATING',
    gpuTypeId: raw.gpuTypeId ?? 'unknown',
    gpuCount: raw.gpuCount ?? 1,
    region: raw.region ?? null,
    publicIp,
    sshPort,
    pricePerHourUsd: typeof raw.pricePerHourUsd === 'number' ? raw.pricePerHourUsd : null,
    attestationReportUrl: raw.attestationReportUrl ?? null,
    createdAt: raw.createdAt ?? null,
  }
}
