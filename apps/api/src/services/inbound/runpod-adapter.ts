/**
 * T5e — RunPod Cloud API adapter (inbound supply, second provider).
 *
 * Mirror of lambda-adapter.ts for RunPod. When the allocator's
 * fallback chain reaches the inbound layer and Lambda has no capacity
 * for the requested GpuTier, the next stop is RunPod. RunPod's
 * capacity windows for 8x H100 / B200 boxes typically don't overlap
 * with Lambda's, so this materially improves "no capacity" UX for
 * buyers asking for high-density boxes.
 *
 * RunPod's model differs from Lambda's:
 *   - Lambda gives you a raw VM with full GPU access; you SSH into the
 *     host OS.
 *   - RunPod gives you a CONTAINER running on a GPU; the SSH server
 *     runs inside the container. We use one of RunPod's base images
 *     that ships with openssh-server pre-installed and inject the
 *     buyer's public key via the PUBLIC_KEY env var.
 *
 * RunPod's REST API:
 *   Base:  https://rest.runpod.io/v1
 *   Auth:  Authorization: Bearer <RUNPOD_API_KEY>
 *   Docs:  https://docs.runpod.io/api-reference/
 *
 * Status mapping (RunPod -> our world):
 *   STARTING  -> PENDING   (container is being scheduled / image pulling)
 *   RUNNING   -> READY     (SSH listening; buyer can connect)
 *   EXITED    -> CLOSED    (container stopped, billing ended)
 *   PAUSED    -> DEGRADED  (RunPod paused billing but instance still allocated)
 *   TERMINATED -> CLOSED   (final state, fully released)
 *
 * Error handling: every public method returns a Promise that rejects
 * with RunPodApiError on non-2xx. Network failures bubble up as
 * ordinary Error.
 *
 * Configurability:
 *   RUNPOD_API_KEY   -> required for any live call
 *   RUNPOD_API_BASE  -> optional override (defaults to prod URL)
 * isRunPodConfigured() is a cheap sync check the allocator uses to
 * decide whether to even attempt the fallback.
 */

const DEFAULT_BASE_URL = 'https://rest.runpod.io/v1'

// Default container image — RunPod's official pytorch image. This is
// the well-documented "SSH-ready" line: their entrypoint reads the
// PUBLIC_KEY env var, writes it to /root/.ssh/authorized_keys, starts
// openssh-server, and keeps the container alive for the rental's
// lifetime. The 'base' family (e.g. runpod/base:0.7.4) does NOT keep
// the container alive — first dry-run hit STARTING -> EXITED in
// seconds.
//
// Provides: Ubuntu 22.04 + CUDA 12.4 + Python 3.11 + PyTorch 2.4 +
// openssh-server + RunPod's SSH entrypoint. Buyers can install other
// frameworks on top via pip / apt after SSH'ing in.
//
// Pin a specific tag so RunPod template changes don't surprise a
// mid-flight rental. Bump intentionally when their image gets
// updated. Buyers can override per-rental via createPod args.
export const DEFAULT_RUNPOD_IMAGE = 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04'

export class RunPodApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `RunPod API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'RunPodApiError'
  }
}

/**
 * GPU type catalog entry. RunPod returns rich metadata; we keep the
 * fields the allocator + inspector actually use.
 */
export interface RunPodGpuType {
  id: string
  /** Human-readable name shown in the UI, e.g. "NVIDIA H100 80GB HBM3". */
  displayName: string
  /** Memory per GPU, in GiB. */
  memoryInGb: number
  /** Lowest per-hour USD price across cloud types (secure + community). */
  lowestPricePerHourUsd: number | null
  /** Per-hour USD for the SECURE tier (RunPod's reliable datacenters). */
  securePricePerHourUsd: number | null
  /** Per-hour USD for the COMMUNITY tier (peer hosts; cheaper but lower SLA). */
  communityPricePerHourUsd: number | null
  /** Whether RunPod reports stock in any tier right now. */
  hasCurrentStock: boolean
}

export type RunPodPodStatus =
  | 'CREATED'
  | 'STARTING'
  | 'RUNNING'
  | 'PAUSED'
  | 'EXITED'
  | 'TERMINATED'

export interface RunPodPod {
  id: string
  name: string | null
  status: RunPodPodStatus
  gpuTypeId: string
  gpuCount: number
  /** Datacenter / region the pod is running in. */
  region: string | null
  /** Public IP the pod is reachable at (when status=RUNNING). */
  publicIp: string | null
  /**
   * Public TCP port mapped to container's port 22. RunPod assigns
   * this dynamically; the buyer SSHes with `ssh root@<ip> -p <port>`.
   */
  sshPort: number | null
  pricePerHourUsd: number | null
  createdAt: string | null
}

export interface CreatePodArgs {
  name: string
  gpuTypeId: string
  gpuCount: number
  /** SSH public key (raw openssh format) the entrypoint injects. */
  sshPublicKey: string
  /** Override the default base image. Must include openssh-server. */
  imageName?: string
  /** Container scratch disk in GB. Default 50. */
  containerDiskInGb?: number
  /** Persistent volume in GB. 0 = no persistent volume. Default 0. */
  volumeInGb?: number
  /**
   * RunPod tier:
   *   SECURE    -> RunPod-owned datacenters, higher reliability, more $
   *   COMMUNITY -> peer-hosted compute, cheapest, variable SLA
   * Default COMMUNITY (cheapest available; matches T5d capacity goal).
   * Note: RunPod's REST spec rejects 'ALL' even though GraphQL accepts
   * it — callers must pick one tier explicitly.
   */
  cloudType?: 'SECURE' | 'COMMUNITY'
}

interface RawGpuTypeResponse {
  id: string
  displayName: string
  memoryInGb: number
  securePrice?: number | null
  communityPrice?: number | null
  lowestPrice?: { uninterruptablePrice?: number | null; minimumBidPrice?: number | null } | null
  secureSpotPrice?: number | null
  communitySpotPrice?: number | null
}

interface RawPodResponse {
  id: string
  name?: string
  desiredStatus?: RunPodPodStatus
  lastStatusChange?: string
  publicIp?: string | null
  machine?: {
    podHostId?: string
    location?: string
    dataCenterId?: string
  }
  gpuTypeId?: string
  gpuCount?: number
  costPerHr?: number | null
  ports?: Array<{ ip?: string; isIpPublic?: boolean; privatePort?: number; publicPort?: number; type?: string }>
  uptimeSeconds?: number
  containerDiskInGb?: number
  volumeInGb?: number
  imageName?: string
  env?: Record<string, string>
  createdAt?: string
}

export function isRunPodConfigured(): boolean {
  return Boolean(process.env.RUNPOD_API_KEY?.trim())
}

export class RunPodClient {
  private readonly base: string
  private readonly authHeader: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.RUNPOD_API_KEY ?? '').trim()
    if (!key) {
      throw new Error(
        'RunPodClient requires RUNPOD_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.base = (baseUrl ?? process.env.RUNPOD_API_BASE ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
    this.authHeader = `Bearer ${key}`
  }

  /**
   * Catalog of every GPU SKU RunPod offers with current pricing across
   * SECURE + COMMUNITY tiers.
   *
   * IMPORTANT: RunPod's REST API (rest.runpod.io) does NOT include a
   * GPU types endpoint as of 2026 — it's only available on their
   * GraphQL API at api.runpod.io/graphql. So this method bypasses
   * the REST base URL and goes straight to GraphQL. Pod CRUD
   * operations stay on REST.
   *
   * RunPod's catalog isn't structured around per-tier "available
   * regions" the way Lambda's is; instead each GPU type exposes a
   * coarse "do we currently have stock" signal we surface as
   * hasCurrentStock. Per-region capacity requires a deeper call we
   * don't need for T5e MVP.
   */
  async listGpuTypes(): Promise<RunPodGpuType[]> {
    const query = `
      query GpuTypes {
        gpuTypes {
          id
          displayName
          memoryInGb
          securePrice
          communityPrice
        }
      }
    `
    const res = await fetch('https://api.runpod.io/graphql', {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    if (!res.ok) {
      throw new RunPodApiError(res.status, '/graphql gpuTypes', parsed ?? text)
    }
    const body = parsed as { data?: { gpuTypes?: RawGpuTypeResponse[] }; errors?: unknown }
    if (body.errors) {
      throw new RunPodApiError(200, '/graphql gpuTypes', body.errors)
    }
    const raw = body.data?.gpuTypes ?? []
    return raw.map((t) => {
      const secure = typeof t.securePrice === 'number' ? t.securePrice : null
      const community = typeof t.communityPrice === 'number' ? t.communityPrice : null
      const lowest = (() => {
        const candidates = [secure, community].filter((p): p is number => p !== null && p > 0)
        return candidates.length === 0 ? null : Math.min(...candidates)
      })()
      return {
        id: t.id,
        displayName: t.displayName,
        memoryInGb: t.memoryInGb,
        lowestPricePerHourUsd: lowest,
        securePricePerHourUsd: secure,
        communityPricePerHourUsd: community,
        // GraphQL returns every SKU regardless of capacity. A non-null
        // price across either tier is the proxy for "we list this SKU
        // as available right now."
        hasCurrentStock: lowest !== null,
      }
    })
  }

  /**
   * GET /pods — list every pod currently allocated on the account.
   * Used by the inspector + orphan reconciler.
   */
  async listPods(): Promise<RunPodPod[]> {
    const raw = await this.request<RawPodResponse[]>('/pods', 'GET')
    return raw.map(normalizePod)
  }

  /**
   * GET /pods/{id} — poll a specific pod during the boot window. The
   * T5b-equivalent poller wakes every ~5s while a rental is PENDING
   * and waits for status=RUNNING + a public IP + SSH port.
   */
  async getPod(id: string): Promise<RunPodPod> {
    const raw = await this.request<RawPodResponse>(
      `/pods/${encodeURIComponent(id)}`,
      'GET',
    )
    return normalizePod(raw)
  }

  /**
   * POST /pods — create + start a pod and begin billing.
   *
   * Image contract: DEFAULT_RUNPOD_IMAGE (runpod/pytorch:*) has a
   * built-in entrypoint that reads PUBLIC_KEY env, writes it to
   * /root/.ssh/authorized_keys, starts openssh-server, and keeps
   * the container alive. So we just set the image + inject PUBLIC_KEY
   * and the pod reaches RUNNING with SSH listening on its own.
   *
   * The earlier 'runpod/base' image did NOT have that entrypoint, so
   * pods went STARTING -> EXITED in seconds (we hit this empirically).
   * Attempted fix by sending dockerStartCmd was silently ignored by
   * RunPod's REST API (no validation error, no effect). Switching to
   * the pytorch image solved it cleanly without us having to manage
   * the start command.
   */
  async createPod(args: CreatePodArgs): Promise<string> {
    const body = {
      name: args.name,
      gpuTypeIds: [args.gpuTypeId],
      gpuCount: args.gpuCount,
      imageName: args.imageName ?? DEFAULT_RUNPOD_IMAGE,
      containerDiskInGb: args.containerDiskInGb ?? 50,
      volumeInGb: args.volumeInGb ?? 0,
      // RunPod's REST spec only accepts 'SECURE' or 'COMMUNITY' (no
      // 'ALL' wildcard like GraphQL allows). Default COMMUNITY to
      // match the T5d capacity goal — cheapest tier with stock.
      cloudType: args.cloudType ?? 'COMMUNITY',
      // Expose container's port 22 publicly. RunPod assigns a
      // dynamic public port; we read it from the pod's ports array
      // after status=RUNNING. REST spec requires array of strings,
      // not a single string.
      ports: ['22/tcp'],
      env: {
        // The image's entrypoint reads this and bootstraps SSH.
        PUBLIC_KEY: args.sshPublicKey,
      },
    }
    const raw = await this.request<{ id: string }>('/pods', 'POST', body)
    return raw.id
  }

  /**
   * POST /pods/{id}/stop — stop a pod and end billing. Idempotent on
   * RunPod's side; calling stop on an already-stopped pod is a no-op.
   *
   * RunPod's stop transitions to EXITED but keeps the pod allocated
   * (for potential resume). To fully release the GPU + stop ALL
   * billing, we additionally call DELETE on the pod afterward (see
   * terminatePod).
   */
  async stopPod(id: string): Promise<void> {
    await this.request<unknown>(
      `/pods/${encodeURIComponent(id)}/stop`,
      'POST',
    )
  }

  /**
   * DELETE /pods/{id} — fully release a pod. Equivalent to "terminate"
   * in Lambda's vocabulary. Stop alone leaves the pod allocated with
   * the container disk preserved; delete tears everything down.
   *
   * Tolerates 404 silently (already deleted / unknown id).
   */
  async terminatePod(id: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/pods/${encodeURIComponent(id)}`,
        'DELETE',
      )
    } catch (err) {
      if (err instanceof RunPodApiError && err.statusCode === 404) return
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
        Authorization: this.authHeader,
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
      throw new RunPodApiError(res.status, path, parsed ?? text)
    }
    return parsed as T
  }
}

function normalizePod(raw: RawPodResponse): RunPodPod {
  // SSH port: find the port entry that maps container's 22.
  let sshPort: number | null = null
  let publicIp: string | null = raw.publicIp ?? null
  if (Array.isArray(raw.ports)) {
    const sshPortEntry = raw.ports.find(
      (p) => p.privatePort === 22 && p.isIpPublic === true && typeof p.publicPort === 'number',
    )
    if (sshPortEntry) {
      sshPort = sshPortEntry.publicPort ?? null
      // Some pod responses include the public IP only inside the ports
      // array, not at the top level. Fall back to that when missing.
      if (!publicIp && typeof sshPortEntry.ip === 'string') publicIp = sshPortEntry.ip
    }
  }
  return {
    id: raw.id,
    name: raw.name ?? null,
    status: raw.desiredStatus ?? 'CREATED',
    gpuTypeId: raw.gpuTypeId ?? 'unknown',
    gpuCount: raw.gpuCount ?? 1,
    region: raw.machine?.location ?? raw.machine?.dataCenterId ?? null,
    publicIp,
    sshPort,
    pricePerHourUsd: typeof raw.costPerHr === 'number' ? raw.costPerHr : null,
    createdAt: raw.createdAt ?? null,
  }
}
