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
import { buildPhalaAppCompose } from './phala-default-compose.js'
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
  /** GPU model: H100, H200, B200 etc. (or 'unknown' for CPU SKUs). */
  gpuModel: string
  /** Memory per GPU in GiB. */
  memoryInGb: number
  /** Per-hour price in USD (Phala converts PHA -> USD if needed). */
  pricePerHourUsd: number
  /** TEE primitives this SKU supports (TDX / SEV-SNP / both). */
  teeSupport: Array<'TDX' | 'SEV-SNP'>
  /** Whether Phala reports stock available right now. */
  hasCurrentStock: boolean
  /** Family group: 'cpu' for tdx.* SKUs, 'gpu' for h200.*. */
  family?: 'cpu' | 'gpu'
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

/**
 * Result of POST /api/v1/cvms/provision. Phala's "dstack app" model:
 * provisioning an app uploads the compose file + registers a
 * content-addressed app identity. Returned app_id + compose_hash are
 * passed verbatim to /api/v1/cvms in step 2 to actually instantiate
 * a CVM. Provisioning an app is FREE — only CVMs cost money.
 *
 * Shape inferred from the 422 on POST /cvms (which named app_id +
 * compose_hash as required body fields). Other fields the provision
 * response may include (kms info, app salt, image hash, etc.) are
 * captured via the index signature so we can pass them through.
 */
export interface PhalaAppProvisioned {
  app_id: string
  compose_hash: string
  [extraField: string]: unknown
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
    const all = await this.listInstanceTypes()
    return all.filter((t) => t.family === 'gpu')
  }

  /**
   * Catalog of EVERY Phala instance type (CPU TEE + GPU TEE). Used by
   * the provision orchestrator's verify-step so CPU SKUs (tdx.small
   * etc.) can be exercised via the --type override path for cheap
   * adapter validation. The standard allocator path still uses
   * listGpuTypes() to stay GPU-only.
   */
  async listInstanceTypes(): Promise<PhalaGpuType[]> {
    const raw = await this.request<RawInstanceTypesResponse>('/instance-types', 'GET')
    if (!raw.result) return []
    return raw.result.flatMap((group) =>
      group.items.map((t) => ({
        id: t.id,
        displayName: t.name ?? t.id,
        gpuModel: parseGpuModel(t.id, t.name),
        memoryInGb: Math.round((t.memory_mb ?? 0) / 1024),
        pricePerHourUsd: parseFloat(t.hourly_rate ?? '0'),
        family: group.name,
        // All Phala instances ship with TDX per dashboard description;
        // SEV-SNP availability is broader on their hardware fleet.
        teeSupport: ['TDX', 'SEV-SNP'] as Array<'TDX' | 'SEV-SNP'>,
        // No per-instance live capacity in this endpoint; createCvm
        // returns 409/503 when capacity is exhausted.
        hasCurrentStock: true,
      })),
    )
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
   * Step 1 of the CVM creation flow: register a dstack "app" with
   * Phala. Returns app_id + compose_hash that step 2 uses to launch
   * the actual CVM. App provisioning is FREE (it just uploads the
   * compose + computes content hashes); only step 2 (createCvm)
   * starts billing.
   *
   * Verified empirically 2026-06-03:
   *   - Endpoint: POST /api/v1/cvms/provision
   *   - Required body fields: compose_file (YAML string), name (str)
   *   - Returns: { app_id, compose_hash, ...other fields we pass
   *     through opaquely to step 2 }
   */
  async provisionApp(args: {
    name: string
    composeFile: Record<string, unknown>
    /**
     * Phala SKU id (e.g. "h200.small"). REQUIRED — dstack apps are
     * SKU-bound at provision time so the app identity is reproducible
     * for attestation (verified 2026-06-03: omitting yields ERR-02-008
     * "You must specify either instance_type or vcpu/memory pair").
     */
    instanceType: string
  }): Promise<PhalaAppProvisioned> {
    return await this.request<PhalaAppProvisioned>(
      '/cvms/provision',
      'POST',
      {
        name: args.name,
        compose_file: args.composeFile,
        instance_type: args.instanceType,
      },
    )
  }

  /**
   * Full CVM creation flow (provisionApp -> launch CVM). Calls step 1
   * then step 2. Returns the CVM id from step 2.
   *
   * Step 2 endpoint: POST /api/v1/cvms (verified — 422 from there
   * named app_id + compose_hash as required fields). Spreading the
   * step-1 response into the step-2 body so any extra fields Phala
   * returns from provisionApp (kms info, app salt, image hash, etc.)
   * are passed through opaquely without us needing to know each one.
   *
   * Confidential VMs typically take longer to boot than standard
   * pods (TEE attestation handshake adds ~30-60s) — expect ~90-180s
   * before RUNNING.
   *
   * Step 2 body field names beyond {app_id, compose_hash} are still
   * best-guess; the next 422 will name any additional required
   * fields. Includes instance_type_id + env (PUBLIC_KEY) for SSH
   * bootstrap, plus optional disk_size_gb.
   */
  async createCvm(args: CreateCvmArgs): Promise<string> {
    // Build the dstack AppCompose envelope (NOT raw docker compose).
    // Phala's /cvms/provision compose_file expects a dstack
    // AppCompose object with metadata (name, manifest_version,
    // runner, docker_compose_file, etc.) wrapping the actual docker
    // compose YAML — verified empirically 2026-06-03.
    const compose = buildPhalaAppCompose({
      name: args.name,
      imageName: args.imageName,
      containerDiskInGb: args.containerDiskInGb,
    })

    // Step 1: register the dstack app (free). The app is SKU-bound
    // at this step so attestation can pin to the exact hardware
    // class — this is the dstack model.
    const app = await this.provisionApp({
      name: args.name,
      composeFile: compose,
      instanceType: args.gpuTypeId,
    })

    // Step 2: launch the CVM. Spread the entire step-1 response so
    // we don't drop any opaque fields Phala uses for attestation
    // (kms id, app salt, image hash, etc.), then add the runtime
    // parameters (instance type, GPU count, env vars, optional disk).
    const body = {
      ...app,
      instance_type_id: args.gpuTypeId,
      // Omit gpu_count for CPU TEE SKUs (tdx.*) where it's 0.
      ...(args.gpuCount > 0 ? { gpu_count: args.gpuCount } : {}),
      env: {
        PUBLIC_KEY: args.sshPublicKey,
      },
      ...(args.containerDiskInGb !== undefined
        ? { disk_size_gb: args.containerDiskInGb }
        : {}),
    }
    const raw = await this.request<{ id: string }>('/cvms', 'POST', body)

    // dstack CVMs are returned in `stopped` state — POST /cvms creates
    // the CVM record + assigns a node but does NOT allocate the VM or
    // start billing. We MUST explicitly call /cvms/{id}/start to
    // provision the TDX instance + boot the container. Verified
    // 2026-06-04 via raw GET /cvms/{id} (instance_id=null, status=
    // 'stopped', endpoints[0].instance=''). Without this step the CVM
    // never reaches running and SSH/HTTPS endpoints stay empty.
    await this.startCvm(raw.id)

    return raw.id
  }

  /**
   * Start a CVM. dstack two-phase pattern: create allocates the slot,
   * start triggers VM provisioning + boot. Idempotent on already-
   * running CVMs (Phala returns 200 or 409 depending on state).
   */
  async startCvm(id: string): Promise<void> {
    await this.request<unknown>(
      `/cvms/${encodeURIComponent(id)}/start`,
      'POST',
    )
  }

  /**
   * Stop a CVM without releasing it. Pauses billing but keeps the
   * CVM record + node allocation. Used to pause without losing
   * scheduled hardware; use terminateCvm to fully release.
   */
  async stopCvm(id: string): Promise<void> {
    await this.request<unknown>(
      `/cvms/${encodeURIComponent(id)}/stop`,
      'POST',
    )
  }

  /**
   * Terminate (delete) a CVM. Fully releases the allocation. For our
   * rental model this is what we call when a buyer's rental ends or
   * the orchestrator decides to refund.
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

// Verified shape from GET /api/v1/cvms/{id} (2026-06-04 raw probe):
// status is LOWERCASE string ("stopped" / "running" / etc); resource +
// node_info + endpoints are the real field locations for instance_type
// / region / SSH endpoint. publicIp + sshPort + ports were never real
// fields — those were best-guess at scaffold time.
interface RawCvmResponse {
  id: string
  name?: string
  status?: string
  instance_id?: string | null
  resource?: {
    instance_type?: string
    vcpu?: number
    memory_in_gb?: number
    disk_in_gb?: number
    gpus?: number
    compute_billing_price?: string
    billing_period?: string
  }
  node_info?: {
    id?: number
    node_id?: number
    name?: string
    region?: string
    status?: string
  }
  endpoints?: Array<{
    app?: string
    instance?: string
  }>
  created_at?: string
  deleted_at?: string | null
  in_progress?: boolean
}

/** Phala returns lowercase statuses ("stopped", "running"); map to our internal enum. */
function mapRawPhalaStatus(raw: string | undefined | null): PhalaCvmStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'creating':
      return 'CREATING'
    case 'starting':
    case 'pending':
      return 'STARTING'
    case 'running':
      return 'RUNNING'
    case 'stopping':
      return 'STOPPING'
    case 'stopped':
      return 'STOPPED'
    case 'terminated':
    case 'deleted':
      return 'TERMINATED'
    default:
      return 'CREATING'
  }
}

function normalizeCvm(raw: RawCvmResponse): PhalaCvm {
  // dstack exposes ports via the gateway URL pattern. When the
  // instance is running, endpoints[].instance is populated with a
  // tproxy-routed URL (TCP-over-TLS); when stopped/booting, instance
  // is empty string and endpoints[].app is an HTTP reverse-proxy URL
  // only. SSH-via-TCP requires tproxy_enabled in the AppCompose +
  // CVM in running state; we surface whichever is available, with
  // instance preferred. Note: Phala does NOT expose raw IP+port for
  // CVMs — buyer connectivity is always via dstack-gateway URL.
  let sshHost: string | null = null
  if (Array.isArray(raw.endpoints)) {
    for (const ep of raw.endpoints) {
      if (ep.instance && ep.instance.length > 0) {
        sshHost = ep.instance
        break
      }
    }
    if (!sshHost) {
      for (const ep of raw.endpoints) {
        if (ep.app && ep.app.length > 0) {
          sshHost = ep.app
          break
        }
      }
    }
  }
  const price = raw.resource?.compute_billing_price
    ? parseFloat(raw.resource.compute_billing_price)
    : null
  return {
    id: raw.id,
    name: raw.name ?? null,
    status: mapRawPhalaStatus(raw.status),
    gpuTypeId: raw.resource?.instance_type ?? 'unknown',
    gpuCount: raw.resource?.gpus ?? 0,
    region: raw.node_info?.region ?? null,
    publicIp: sshHost,
    sshPort: sshHost ? 22 : null,
    pricePerHourUsd: typeof price === 'number' && !Number.isNaN(price) ? price : null,
    attestationReportUrl: null,
    createdAt: raw.created_at ?? null,
  }
}
