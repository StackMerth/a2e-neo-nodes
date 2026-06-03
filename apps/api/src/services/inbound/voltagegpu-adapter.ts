/**
 * T5h / Phase 3 — VoltageGPU API adapter (inbound confidential
 * supply).
 *
 * Fifth inbound provider after Lambda + RunPod + Phala (parked) +
 * io.net. VoltageGPU is the third-round research winner: only
 * provider in the market today that hits ALL five criteria for
 * self-serve confidential GPU compute:
 *
 *   1. Confidential GPU primitives: Intel TDX + NVIDIA H100/H200/
 *      B200 in CC mode (real GPU TEE, not CPU-only enclaves)
 *   2. Public REST API with Bearer token auth (no wallet, no invite)
 *   3. USD billing via Stripe (+ optional crypto)
 *   4. Per-second granularity, no minimum rental term
 *   5. ~60s provisioning per their docs
 *
 * Pricing (2026-06-03): H100 $2.77/h, H200 $4.07/h, B200 listed.
 * Compared to Azure NCCadsH100v5 ($8.90/h H100) the runner-up,
 * VoltageGPU is 3x cheaper.
 *
 * IMPORTANT — docs were not reachable from the research sandbox
 * (docs.voltagegpu.com 5xx'd), so the request/response shapes here
 * are BEST-GUESS inferred from third-party blog posts + their
 * public pricing page. Same empirical-discovery pattern as Phala
 * and io.net: expect some 422s on first scaffold attempt; iterate
 * the body shape from the validation error messages.
 *
 * Caveats to validate empirically:
 *   - Young company, capacity + SLA all first-party claims
 *   - EU-only region as of June 2026
 *   - Concentration risk if they resell from a single datacenter
 *
 * Adapter activation path:
 *   1. USER signs up at voltagegpu.com ($5 free credit, no card)
 *   2. USER creates API key from dashboard
 *   3. USER adds VOLTAGEGPU_API_KEY to Render API env
 *   4. Run `pnpm --filter @a2e/api voltagegpu:inspect` (read-only,
 *      validates auth + lists catalog)
 *   5. Run `pnpm --filter @a2e/api voltagegpu-provision:test --type <id>`
 *      using the $5 free credit (smoke test costs ~$0.03 for a
 *      1-minute H100 burst)
 *   6. Set VOLTAGEGPU_ALLOCATOR_ENABLED=true
 *   7. Allocator routes confidential-tier requests to VoltageGPU as
 *      6th-priority fallback (after io.net)
 */

// Volt API (confidential pods/machines/SSH/templates) is at /api/volt/*
// with X-API-Key auth. The /v1/* prefix is for the SEPARATE
// OpenAI-compatible confidential inference API which uses Bearer
// auth and is not handled by this adapter. Verified against
// docs.voltagegpu.com 2026-06-03.
const DEFAULT_BASE_URL = 'https://api.voltagegpu.com/api/volt'

/**
 * Default template UID — "Docker and Systemd Container" template
 * verified in inventory 2026-06-03 (volt templates list). Has
 * systemd as PID 1 (long-running) + sshd configured + injects the
 * registered SSH keys at boot. Required because plain image names
 * like "ubuntu:22.04" exit immediately (code 0 -> Kubernetes
 * CrashLoopBackOff -> pod status flips to "error").
 *
 * Override per-pod by passing template/image explicitly. Future
 * enhancement: let buyers choose Jupyter / Docker / custom from
 * the portal UI.
 */
export const VOLTAGEGPU_DEFAULT_TEMPLATE = 'tpl-igm0l8262qxp'

/** Constant jump-host SSH endpoint (verified 2026-06-03). */
export const VOLTAGEGPU_SSH_HOST = 'ssh.voltagegpu.com'

export class VoltageGpuApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `VoltageGPU API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'VoltageGpuApiError'
  }
}

/**
 * VoltageGPU pod SKU. Shape inferred from public pricing page +
 * research. Field names BEST-GUESS, verify empirically.
 */
export interface VoltageGpuOffer {
  /** Pass to createPod as gpu_type / sku / hardware id. */
  id: string
  /** Human-readable label e.g. "H100 80GB Confidential". */
  name: string
  /** GPU model (H100 / H200 / B200). */
  gpuModel: string
  /** Number of GPUs in this SKU. */
  gpuCount: number
  /** USD per hour. */
  pricePerHourUsd: number
  /** Region code (EU only as of June 2026). */
  region: string
  /** Whether confidential compute (TDX + CC mode) is enabled. */
  confidential: boolean
  /** Live stock availability flag. */
  available: boolean
  /** Raw API row in case the caller needs unknown fields. */
  raw: Record<string, unknown>
}

/**
 * Pod lifecycle states. VoltageGPU returns UPPERCASE values
 * (verified 2026-06-03: "RUNNING" in createPod response). Adapter
 * accepts mixed case; normalizer lower-cases for internal mapping.
 */
export type VoltageGpuPodStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'terminated'
  | 'failed'

export interface VoltageGpuPod {
  id: string
  status: VoltageGpuPodStatus
  gpuType: string
  gpuCount: number
  region: string | null
  publicIp: string | null
  sshPort: number | null
  sshUser: string | null
  pricePerHourUsd: number | null
  createdAt: string | null
  /** Attestation report (DCAP quote or URL); Phase 1.8+ surface. */
  attestationReportUrl: string | null
  /**
   * Human-readable status message from the provider (verified GET
   * response 2026-06-03 includes a `message` field on error states,
   * e.g. "Container keeps crashing — back-off 2m40s ..."). Useful
   * to surface in ExternalRental.lastError for failed rentals.
   */
  statusMessage: string | null
  raw: Record<string, unknown>
}

/**
 * Rich result returned by createPod. The POST /pods response
 * contains SSH connection info (targonUid, ssh_command) that the
 * GET /pods/{id} response does NOT include — so we must persist
 * SSH credentials at provision time, not during polling.
 */
export interface CreatePodResult {
  /** Canonical pod id (cuid). Use for getPod / terminatePod URLs. */
  id: string
  /** Worker uid for the jump-host SSH connection (e.g. "wrk-..."). */
  targonUid: string | null
  /** Full ssh_command string ("ssh <targonUid>@ssh.voltagegpu.com"). */
  sshCommand: string | null
  /** Initial status from create response (often "running" already). */
  status: VoltageGpuPodStatus | null
}

export interface CreatePodArgs {
  /** Friendly name shown in dashboard / used as a lookup handle. */
  name: string
  /** Offer id from listOffers (e.g. "h100", "h200", or whatever shape). */
  gpuType: string
  /** GPUs per pod (1, 2, 4, 8). */
  gpuCount: number
  /** SSH public key (openssh format). Injected at boot. */
  sshPublicKey: string
  /** Region preference. */
  region?: string
  /** Whether to enforce confidential compute. Default true. */
  confidential?: boolean
  /**
   * Template UID for the pod's container manifest. Templates provide
   * a long-running PID 1 + sshd + GPU drivers. Defaults to
   * VOLTAGEGPU_DEFAULT_TEMPLATE (Docker + Systemd). Mutually
   * exclusive with `image`.
   */
  template?: string
  /**
   * Custom Docker image. Must have a long-running PID 1 (otherwise
   * Kubernetes CrashLoopBackOff). Mutually exclusive with `template`.
   * Setting this overrides the default template.
   */
  image?: string
}

export function isVoltageGpuConfigured(): boolean {
  return Boolean(process.env.VOLTAGEGPU_API_KEY?.trim())
}

export class VoltageGpuClient {
  private readonly base: string
  private readonly apiKey: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.VOLTAGEGPU_API_KEY ?? '').trim()
    if (!key) {
      throw new Error(
        'VoltageGpuClient requires VOLTAGEGPU_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.base = (
      baseUrl ?? process.env.VOLTAGEGPU_API_BASE ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '')
    this.apiKey = key
  }

  /**
   * Catalog of available TDX-sealed GPU machines. Verified path
   * 2026-06-03: GET /api/volt/machines. Response shape unwrap is
   * defensive — handles {machines:[]}, {data:[]}, or [].
   */
  async listOffers(): Promise<VoltageGpuOffer[]> {
    const raw = await this.request<unknown>('/machines', 'GET')
    const items: RawOfferItem[] = Array.isArray(raw)
      ? raw
      : ((raw as { machines?: RawOfferItem[] }).machines ??
        (raw as { offers?: RawOfferItem[] }).offers ??
        (raw as { data?: RawOfferItem[] }).data ??
        [])
    return items.map(normalizeOffer)
  }

  /** List currently-running pods on the account (GET /api/volt/pods). */
  async listPods(): Promise<VoltageGpuPod[]> {
    const raw = await this.request<unknown>('/pods', 'GET')
    const items: RawPodItem[] = Array.isArray(raw)
      ? raw
      : ((raw as { pods?: RawPodItem[]; data?: RawPodItem[] }).pods ??
        (raw as { data?: RawPodItem[] }).data ??
        [])
    return items.map(normalizePod)
  }

  /** Fetch one pod by id. */
  async getPod(id: string): Promise<VoltageGpuPod> {
    const raw = await this.request<unknown>(
      `/pods/${encodeURIComponent(id)}`,
      'GET',
    )
    const item =
      (raw as { data?: RawPodItem; pod?: RawPodItem }).data ??
      (raw as { pod?: RawPodItem }).pod ??
      (raw as RawPodItem)
    return normalizePod(item)
  }

  /**
   * Register an SSH key. Required body uses snake_case
   * `public_key` (verified 2026-06-03 against POST returning 201).
   * VoltageGPU's own CLI v1.2.1 has a bug: it sends camelCase
   * `publicKey` which the API rejects with 400 "name and public_key
   * required". Their bug, our adapter's win.
   *
   * Returns the SSH key UID for use in createPod's ssh_keys array.
   */
  async registerSshKey(args: { name: string; publicKey: string }): Promise<string> {
    const body = {
      name: args.name,
      public_key: args.publicKey,
    }
    const raw = await this.request<unknown>('/ssh-keys', 'POST', body)
    // Response shape: stored object with `id` (cuid-style) field.
    const r = raw as { id?: string; data?: { id?: string } }
    const id = r.id ?? r.data?.id
    if (!id) {
      throw new VoltageGpuApiError(
        500,
        '/ssh-keys',
        `Could not extract id from response: ${JSON.stringify(raw)}`,
      )
    }
    return id
  }

  /** Delete an SSH key by id. Idempotent on 404. */
  async deleteSshKey(id: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/ssh-keys/${encodeURIComponent(id)}`,
        'DELETE',
      )
    } catch (err) {
      if (err instanceof VoltageGpuApiError && err.statusCode === 404) return
      throw err
    }
  }

  /**
   * Create a confidential pod via POST /api/volt/pods. Body shape
   * still BEST-GUESS — iterate from the first 422 response if it
   * surfaces required fields we missed.
   */
  async createPod(args: CreatePodArgs & { sshKeyIds?: string[]; provider?: string }): Promise<CreatePodResult> {
    // Verified body shape captured 2026-06-03 via httpx monkey-patch
    // of the official volt CLI + first real provision.
    // Required: provider, name, resource_name, plus EITHER image
    // OR template. Optional: ssh_keys (array of pre-registered uids).
    //
    // Default image (ubuntu:22.04) is INVALID — it exits immediately
    // and triggers CrashLoopBackOff. Default to the systemd template
    // which has long-running PID 1 + sshd configured. Buyer can
    // override per-rental via args.image or args.template.
    const body: Record<string, unknown> = {
      provider: args.provider ?? 'targon',
      name: args.name,
      resource_name: args.gpuType,
    }
    if (args.image) {
      body.image = args.image
    } else {
      body.template = args.template ?? VOLTAGEGPU_DEFAULT_TEMPLATE
    }
    if (args.sshKeyIds && args.sshKeyIds.length > 0) {
      body.ssh_keys = args.sshKeyIds
    }
    const raw = await this.request<unknown>('/pods', 'POST', body)
    // POST response shape:
    //   { "success": true, "pod": { "id", "targonUid",
    //     "ssh_command", "status": "RUNNING", "provider": "...", ... } }
    // SSH info (targonUid, ssh_command) is ONLY here — GET /pods/{id}
    // does NOT return it. Caller MUST persist SSH details at provision
    // time using the returned CreatePodResult, not wait for poll.
    const r = raw as {
      success?: boolean
      pod?: {
        id?: string
        targonUid?: string
        ssh_command?: string
        status?: string
      }
      id?: string
      pod_id?: string
      data?: { id?: string; pod_id?: string }
    }
    const pod = r.pod
    const id = pod?.id ?? r.id ?? r.pod_id ?? r.data?.id ?? r.data?.pod_id
    if (!id) {
      throw new VoltageGpuApiError(
        500,
        '/pods',
        `Could not extract pod id from response: ${JSON.stringify(raw)}`,
      )
    }
    return {
      id,
      targonUid: pod?.targonUid ?? null,
      sshCommand: pod?.ssh_command ?? null,
      status: pod?.status
        ? (pod.status.toLowerCase() as VoltageGpuPodStatus)
        : null,
    }
  }

  /**
   * Terminate a pod. Idempotent on the VoltageGPU side per common
   * REST conventions; treats 404 as no-op.
   */
  async terminatePod(id: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/pods/${encodeURIComponent(id)}`,
        'DELETE',
      )
    } catch (err) {
      if (err instanceof VoltageGpuApiError && err.statusCode === 404) return
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
        // Volt API uses X-API-Key, NOT Authorization: Bearer.
        // Bearer auth is reserved for the SEPARATE OpenAI-compat
        // inference API at /v1/* (not handled by this adapter).
        // Verified against docs.voltagegpu.com 2026-06-03.
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
      throw new VoltageGpuApiError(res.status, path, parsed ?? text)
    }
    return parsed as T
  }
}

// ---------------------------------------------------------------------------
// Raw response shapes + normalizers (BEST-GUESS, verify empirically)
// ---------------------------------------------------------------------------

/**
 * Verified shape from GET /api/volt/machines (2026-06-03):
 *   {
 *     "name": "NVIDIA H100 - Small [Confidential]",
 *     "price": 3.75,
 *     "rental_rate": 3.75,
 *     "p_min": 2.5, "p_max": 3.75, "base_price": 2.5,
 *     "total_gpu_count": 21,
 *     "k": 1,
 *     "provider": "targon",
 *     "resource_name": "h100-small",
 *     "gpu_type": "NVIDIA-H100",
 *     "gpu_count": 1,
 *     "vcpu": 14375,
 *     "memory": 175000,
 *     "confidential_compute": true
 *   }
 *
 * resource_name is the canonical machine identifier passed to
 * createPod. gpu_type carries the "NVIDIA-" prefix on the model
 * which we strip for display. No region field — single-region
 * (EU) per research.
 *
 * p_min / p_max indicate dynamic / auction-style pricing; we
 * snapshot `price` (current rental_rate) at provision time.
 */
interface RawOfferItem {
  name?: string
  resource_name?: string
  gpu_type?: string
  gpu_count?: number
  price?: number
  rental_rate?: number
  p_min?: number
  p_max?: number
  total_gpu_count?: number
  k?: number
  provider?: string
  vcpu?: number
  memory?: number
  confidential_compute?: boolean
  [extra: string]: unknown
}

function normalizeOffer(raw: RawOfferItem): VoltageGpuOffer {
  // Strip the "NVIDIA-" prefix from gpu_type for display
  // (e.g. "NVIDIA-H100" -> "H100").
  const gpuModel = (raw.gpu_type ?? '').replace(/^NVIDIA-/i, '') ||
    parseGpuModelFromName(raw.name ?? '')
  return {
    id: raw.resource_name ?? '',
    name: raw.name ?? raw.resource_name ?? '',
    gpuModel,
    gpuCount: raw.gpu_count ?? 1,
    pricePerHourUsd: raw.price ?? raw.rental_rate ?? 0,
    region: 'EU',
    confidential: raw.confidential_compute ?? true,
    // total_gpu_count > 0 implies stock; treat 0 / undefined as no.
    available: (raw.total_gpu_count ?? 0) > 0,
    raw,
  }
}

/**
 * Real GET /pods/{id} response (verified 2026-06-03):
 *   {
 *     "uid": "wrk-2cj7aibmu91j",
 *     "workload_type": "RENTAL",
 *     "status": "error",
 *     "message": "Container keeps crashing — back-off 2m40s ...",
 *     "ready_replicas": 0,
 *     "total_replicas": 0,
 *     "updated_at": "2026-06-03T21:25:17.461136Z"
 *   }
 *
 * VERY DIFFERENT from the POST /pods response. SSH info is NOT here —
 * only the workload status. We capture SSH at provision time and
 * use this response only to update status + capture error messages.
 */
interface RawPodItem {
  // GET response fields
  uid?: string
  workload_type?: string
  status?: string
  message?: string
  ready_replicas?: number
  total_replicas?: number
  updated_at?: string
  // POST response fields (kept for createPod normalization)
  id?: string
  pod_id?: string
  targonUid?: string
  resource_name?: string
  gpu_type?: string
  gpu_count?: number
  region?: string
  public_ip?: string
  ssh_command?: string
  ssh_port?: number
  ssh_user?: string
  ssh_username?: string
  hourlyPrice?: number
  price_per_hour?: number
  provider?: string
  attestation_url?: string
  attestation_report_url?: string
  created_at?: string
  [extra: string]: unknown
}

/**
 * Parse VoltageGPU's ssh_command string into (host, user) parts.
 * Format: "ssh <user>@<host>" (no port flag implies default 22).
 */
function parseSshCommand(s: string | undefined): { host: string | null; user: string | null } {
  if (!s) return { host: null, user: null }
  const m = s.match(/ssh\s+(?:-p\s+\d+\s+)?([^@\s]+)@([\w.\-]+)/i)
  if (!m) return { host: null, user: null }
  return { user: m[1] ?? null, host: m[2] ?? null }
}

function normalizePod(raw: RawPodItem): VoltageGpuPod {
  // VoltageGPU returns mixed-case status across endpoints
  // ("RUNNING" in POST, "error" in GET). Lowercase before mapping.
  const status = ((raw.status ?? 'creating') as string).toLowerCase() as VoltageGpuPodStatus
  // SSH info only present on POST responses. On GET it's null.
  const parsed = parseSshCommand(raw.ssh_command)
  const sshHost = raw.public_ip ?? parsed.host
  const sshUser =
    raw.ssh_user ?? raw.ssh_username ?? raw.targonUid ?? parsed.user
  return {
    id: raw.id ?? raw.pod_id ?? raw.uid ?? '',
    status,
    gpuType: raw.gpu_type ?? raw.resource_name ?? '',
    gpuCount: raw.gpu_count ?? 1,
    region: raw.region ?? null,
    publicIp: sshHost,
    sshPort: typeof raw.ssh_port === 'number' ? raw.ssh_port : 22,
    sshUser,
    pricePerHourUsd:
      typeof raw.hourlyPrice === 'number'
        ? raw.hourlyPrice
        : typeof raw.price_per_hour === 'number'
          ? raw.price_per_hour
          : null,
    attestationReportUrl: raw.attestation_url ?? raw.attestation_report_url ?? null,
    statusMessage: raw.message ?? null,
    createdAt: raw.created_at ?? raw.updated_at ?? null,
    raw,
  }
}

function parseGpuModelFromName(s: string): string {
  const m = s.toUpperCase().match(/(H100|H200|B200|B300|L40S|RTX\s*\d+)/)
  return m && m[1] ? m[1].replace(/\s+/g, '') : 'unknown'
}
