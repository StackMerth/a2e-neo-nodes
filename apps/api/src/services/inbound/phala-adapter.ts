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
 * Default CVM template image. Phala Cloud publishes pre-built CVM
 * images optimized for confidential AI workloads (Ubuntu + CUDA +
 * openssh-server + their TEE bootstrap). We pin a specific template
 * id once we know the real catalog format; for now this is a
 * placeholder that the inspector + provisioning code reads from
 * env so we can iterate without code changes.
 *
 * Set PHALA_DEFAULT_CVM_IMAGE in Render env once you've identified
 * the correct image id from Phala Cloud's console. Until then the
 * createCvm call will use whatever fallback is configured in the
 * provisioning orchestrator.
 */
export const DEFAULT_PHALA_IMAGE = process.env.PHALA_DEFAULT_CVM_IMAGE ?? 'phala/cuda-pytorch:latest'

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
    // Phala uses APIKeyHeader auth per their OpenAPI spec. The exact
    // header name (X-API-Key vs Authorization Bearer vs bare
    // Authorization) is still being verified empirically; the request
    // method sends both common variants so whichever the gateway
    // accepts will work. Once we know the canonical one we drop the
    // redundant header.
    this.apiKey = key
  }

  /**
   * Catalog of available GPU instance types Phala offers. Per the
   * OpenAPI spec the path is /instance-types (sibling of /cvms);
   * GPU CVMs are filtered by capability. May need refinement once
   * we see a real response shape.
   */
  async listGpuTypes(): Promise<PhalaGpuType[]> {
    const raw = await this.request<RawGpuTypeResponse[]>('/instance-types', 'GET')
    return raw.map((t) => ({
      id: t.id,
      displayName: t.displayName ?? t.name ?? t.id,
      gpuModel: t.gpuModel ?? 'unknown',
      memoryInGb: t.memoryInGb ?? 0,
      pricePerHourUsd: t.pricePerHourUsd ?? 0,
      teeSupport: t.teeSupport ?? ['TDX'],
      hasCurrentStock: t.hasCurrentStock ?? true,
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
    const body = {
      name: args.name,
      gpuTypeId: args.gpuTypeId,
      gpuCount: args.gpuCount,
      imageName: args.imageName ?? DEFAULT_PHALA_IMAGE,
      containerDiskInGb: args.containerDiskInGb ?? 50,
      teeMode: args.teeMode ?? 'ANY',
      env: {
        // Standard SSH bootstrap convention; CVM image's entrypoint
        // reads this and appends to /root/.ssh/authorized_keys.
        PUBLIC_KEY: args.sshPublicKey,
      },
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
        // Phala OpenAPI spec says "APIKeyHeader" without naming the
        // header. Send both common variants; whichever the gateway
        // recognizes will authenticate. After the first successful
        // call, simplify to the canonical one.
        'X-API-Key': this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
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

interface RawGpuTypeResponse {
  id: string
  name?: string
  displayName?: string
  gpuModel?: string
  memoryInGb?: number
  pricePerHourUsd?: number
  teeSupport?: Array<'TDX' | 'SEV-SNP'>
  hasCurrentStock?: boolean
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
