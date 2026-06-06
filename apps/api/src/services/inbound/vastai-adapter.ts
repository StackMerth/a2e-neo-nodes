/**
 * Vast.ai REST adapter (inbound supply, fifth provider after Lambda /
 * RunPod / io.net / Phala).
 *
 * Why Vast.ai. Today (2026-06-06) RunPod's COMMUNITY tier is the only
 * place in our cascade where consumer GPUs (RTX 4090 / 3090) can be
 * provisioned, and that pool is empirically flaky: stock vanishes
 * between probe and provision, network metadata sometimes never
 * propagates, etc. Vast.ai is a peer-to-peer GPU marketplace with
 * dramatically larger inventory of consumer cards (200+ 4090 listings
 * at most hours, even more 3090s) plus a healthy secondary supply of
 * H100 / A100 / L40S. Adding it as a second consumer-tier supplier is
 * the cheapest way to close the supply gap that left buyers stuck for
 * hours today.
 *
 * Vast.ai's model.
 *   - Hosts (machine owners) publish OFFERS for their GPU rigs.
 *   - The API exposes search via /bundles/ — a JSON query that filters
 *     offers by GPU model, count, RAM, disk, geographic region,
 *     verified-host status, etc.
 *   - Buyers BOOK an offer by PUT /asks/<offer_id>/, which creates an
 *     INSTANCE on the host.
 *   - Instances are billed PER SECOND (much friendlier than RunPod's
 *     per-minute / Lambda's per-hour) and run a Docker image specified
 *     at provision time.
 *   - SSH access works the same way as RunPod: instance gets a public
 *     IP + port, image entrypoint installs the buyer's pubkey into the
 *     container's authorized_keys.
 *
 * REST API.
 *   Base:    https://console.vast.ai/api/v0
 *   Auth:    Authorization: Bearer <VASTAI_API_KEY>
 *   Docs:    https://docs.vast.ai/api/
 *
 * Status mapping (Vast.ai -> our world).
 *   loading      -> PENDING   (host pulling image, container scheduling)
 *   running      -> READY     (container running, SSH listening)
 *   exited       -> CLOSED    (container stopped)
 *   stopping     -> DEGRADED  (transient teardown state)
 *   created      -> PENDING   (newly-booked, not yet started)
 *
 * Configurability.
 *   VASTAI_API_KEY        -> required for any live call
 *   VASTAI_API_BASE       -> optional override (defaults to prod URL)
 *   VASTAI_ALLOCATOR_ENABLED  -> 'true' to include in the cascade.
 *     Defaults to 'false' so the adapter stays gated off until catalog
 *     mapping + provision flow are fully proven. Lets us ship phase 1
 *     to production without affecting buyer requests.
 *
 * isVastAiConfigured() is the cheap sync gate the allocator + probe
 * check before attempting anything.
 */

const DEFAULT_BASE_URL = 'https://console.vast.ai/api/v0'

// Default container image for Vast.ai instances. Same family as the
// RunPod default (pytorch + cuda + openssh-server preinstalled) so the
// SSH bootstrap behaves identically across providers from the buyer's
// perspective. The PyTorch official image ships sshd disabled by
// default; we layer on Vast.ai's recommended startup_script in the
// provision call to enable it.
//
// Pin the same image hub as RunPod (runpod/pytorch) because we've
// already verified it works end-to-end on community-tier hosts. If
// Vast.ai's network can't pull from RunPod's Docker Hub org for some
// reason, swap to pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel.
export const DEFAULT_VASTAI_IMAGE = 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04'

export class VastAiApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `Vast.ai API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'VastAiApiError'
  }
}

/**
 * An offer (= "ask" in Vast.ai's terminology) — what a host is
 * willing to rent. Returned by GET /bundles/. Fields here are the
 * subset our allocator + tier mapping actually consumes.
 */
export interface VastAiOffer {
  /** Offer id; used as the path segment in PUT /asks/<id>/ to book. */
  id: number
  /** GPU model display name, e.g. "RTX_4090". Vast uses uppercase with underscores. */
  gpuName: string
  /** Number of GPUs on this offer. */
  numGpus: number
  /** GPU RAM per card in GB. */
  gpuRam: number
  /** Per-hour USD price the host is asking (excluding storage cost). */
  dphTotal: number
  /** Host's geographic location string (often "US", "DE", etc.). */
  geolocation: string | null
  /** Vast.ai's reliability score 0-1; we filter > 0.95 for verified-host SLA. */
  reliability: number
  /** True if Vast.ai has verified the host's hardware. We only book verified. */
  verified: boolean
  /** Free disk space on host in GB. */
  diskSpace: number
  /** True if the host currently has the offer available. */
  rentable: boolean
}

export type VastAiInstanceStatus =
  | 'created'
  | 'loading'
  | 'running'
  | 'stopping'
  | 'exited'

/**
 * A booked instance. Returned by GET /instances/<id>/.
 */
export interface VastAiInstance {
  id: number
  /** Maps to our ExternalRental.status. */
  status: VastAiInstanceStatus
  gpuName: string
  numGpus: number
  /** Public IP for SSH — populated once status=running. */
  publicIpaddr: string | null
  /**
   * SSH port. Vast.ai maps the container's port 22 to a host port
   * dynamically; populated once status=running.
   */
  sshPort: number | null
  /** Per-hour rate this instance is billed at. */
  dphTotal: number
  /** Image name the instance is running. */
  imageName: string | null
  /** Geographic location of the host. */
  geolocation: string | null
}

export interface BookOfferArgs {
  /** Offer id from /bundles/ search. */
  offerId: number
  /** Container image to run. Defaults to DEFAULT_VASTAI_IMAGE. */
  imageName?: string
  /** SSH public key (openssh format) the entrypoint installs. */
  sshPublicKey: string
  /** Container disk allocation in GB. Default 50. */
  diskGb?: number
}

interface RawOfferResponse {
  id: number
  gpu_name?: string
  num_gpus?: number
  gpu_ram?: number
  dph_total?: number
  geolocation?: string | null
  reliability2?: number
  verified?: boolean
  disk_space?: number
  rentable?: boolean
}

interface RawInstanceResponse {
  id: number
  actual_status?: VastAiInstanceStatus | string
  cur_state?: VastAiInstanceStatus | string
  gpu_name?: string
  num_gpus?: number
  public_ipaddr?: string | null
  ssh_port?: number | null
  dph_total?: number
  image?: string | null
  geolocation?: string | null
}

/**
 * Cheap sync check. The allocator calls this BEFORE building a request
 * and before any network round trip. Used to short-circuit the Vast.ai
 * fallback when the env isn't fully set, so misconfigured deployments
 * don't show a confusing "Vast.ai didn't respond" error to buyers —
 * they just never see Vast.ai in the cascade.
 */
export function isVastAiConfigured(): boolean {
  return !!process.env.VASTAI_API_KEY?.trim()
}

/**
 * Separate gate from isVastAiConfigured: even with a valid API key,
 * we keep Vast.ai out of the buyer-facing cascade until the catalog
 * mapping + provision flow are verified end-to-end. Default off.
 * Operator opts into production traffic via VASTAI_ALLOCATOR_ENABLED.
 */
export function isVastAiAllocatorEnabled(): boolean {
  return process.env.VASTAI_ALLOCATOR_ENABLED?.toLowerCase() === 'true'
}

export class VastAiClient {
  private baseUrl: string
  private apiKey: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.VASTAI_API_KEY)?.trim()
    if (!key) {
      throw new Error(
        'VastAiClient requires VASTAI_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.apiKey = key
    this.baseUrl = (baseUrl ?? process.env.VASTAI_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      let parsed: unknown = await res.text()
      try {
        parsed = JSON.parse(parsed as string)
      } catch {
        // fall through with the raw text
      }
      throw new VastAiApiError(res.status, path, parsed)
    }
    return (await res.json()) as T
  }

  /**
   * Search offers via Vast.ai's bundles endpoint. The query is a JSON
   * object Vast.ai matches against offer attributes.
   *
   * Example:
   *   listOffers({ gpu_name: 'RTX_4090', num_gpus: 1, verified: true })
   *
   * Returns offers sorted by `dph_total` ascending so the cheapest
   * verified host comes first. Caller is responsible for filtering on
   * reliability / disk / region as needed.
   */
  async listOffers(query: Record<string, unknown> = {}): Promise<VastAiOffer[]> {
    // Vast.ai's /bundles/ takes the search query as a URL-encoded JSON
    // blob in the `q` query string. Verified-host + rentable filters
    // are essentially always wanted; callers can override either by
    // passing them explicitly in `query`.
    const finalQuery = {
      verified: { eq: true },
      rentable: { eq: true },
      order: [['dph_total', 'asc']],
      ...query,
    }
    const encoded = encodeURIComponent(JSON.stringify(finalQuery))
    const raw = await this.request<{ offers?: RawOfferResponse[] }>(`/bundles/?q=${encoded}`, 'GET')
    return (raw.offers ?? []).map(normalizeOffer)
  }

  /**
   * Book an offer. Creates an instance on the host. Vast.ai returns
   * the new instance id immediately; status starts at 'created' and
   * transitions through 'loading' (image pull) into 'running'.
   */
  async bookOffer(args: BookOfferArgs): Promise<number> {
    const body = {
      client_id: 'me',
      image: args.imageName ?? DEFAULT_VASTAI_IMAGE,
      disk: args.diskGb ?? 50,
      // Vast.ai's onstart script runs once at container start. We use
      // it to install the buyer's pubkey into root's authorized_keys
      // (the default user on most pytorch images) and start sshd.
      onstart: [
        'mkdir -p /root/.ssh',
        `echo '${args.sshPublicKey.trim()}' > /root/.ssh/authorized_keys`,
        'chmod 700 /root/.ssh',
        'chmod 600 /root/.ssh/authorized_keys',
        'service ssh start 2>/dev/null || /usr/sbin/sshd',
      ].join(' && '),
    }
    const res = await this.request<{ new_contract?: number; success?: boolean }>(
      `/asks/${args.offerId}/`,
      'PUT',
      body,
    )
    if (!res.success || typeof res.new_contract !== 'number') {
      throw new VastAiApiError(200, `/asks/${args.offerId}/`, res)
    }
    return res.new_contract
  }

  /**
   * Get an instance's current state. Used by the poll worker to
   * detect READY -> publish SSH info; CLOSED -> mark rental ended.
   */
  async getInstance(id: number): Promise<VastAiInstance> {
    const raw = await this.request<{ instances?: RawInstanceResponse }>(
      `/instances/${id}/`,
      'GET',
    )
    const inst = raw.instances
    if (!inst) {
      throw new VastAiApiError(404, `/instances/${id}/`, raw)
    }
    return normalizeInstance(inst)
  }

  /**
   * Destroy an instance. Vast.ai bills until the destroy call lands;
   * idempotent (re-destroying a destroyed instance returns 200).
   */
  async destroyInstance(id: number): Promise<void> {
    await this.request<unknown>(`/instances/${id}/`, 'DELETE')
  }
}

function normalizeOffer(raw: RawOfferResponse): VastAiOffer {
  return {
    id: raw.id,
    gpuName: raw.gpu_name ?? 'UNKNOWN',
    numGpus: raw.num_gpus ?? 1,
    gpuRam: raw.gpu_ram ?? 0,
    dphTotal: raw.dph_total ?? 0,
    geolocation: raw.geolocation ?? null,
    reliability: raw.reliability2 ?? 0,
    verified: raw.verified === true,
    diskSpace: raw.disk_space ?? 0,
    rentable: raw.rentable === true,
  }
}

function normalizeInstance(raw: RawInstanceResponse): VastAiInstance {
  // Vast.ai exposes two status-ish fields (actual_status from the
  // host's report vs cur_state from the API's view). actual_status is
  // the more accurate signal for buyer-visible readiness; fall back to
  // cur_state if missing.
  const rawStatus = (raw.actual_status ?? raw.cur_state ?? 'created') as string
  const status: VastAiInstanceStatus =
    rawStatus === 'running' || rawStatus === 'loading' || rawStatus === 'exited' || rawStatus === 'stopping'
      ? rawStatus
      : 'created'
  return {
    id: raw.id,
    status,
    gpuName: raw.gpu_name ?? 'UNKNOWN',
    numGpus: raw.num_gpus ?? 1,
    publicIpaddr: raw.public_ipaddr ?? null,
    sshPort: typeof raw.ssh_port === 'number' ? raw.ssh_port : null,
    dphTotal: raw.dph_total ?? 0,
    imageName: raw.image ?? null,
    geolocation: raw.geolocation ?? null,
  }
}
