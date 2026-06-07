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

// Default container image for Vast.ai instances. We use the OFFICIAL
// PyTorch image (pytorch/pytorch) rather than the RunPod variant we use
// elsewhere, because RunPod's image has a custom entrypoint that
// expects RunPod-specific env vars (PUBLIC_KEY, etc.) and Vast.ai's
// Dockerfile generator fails on it with "docker_build() error writing
// dockerfile" (observed 2026-06-06 on rental cmq2tzyj4000 / instance
// 39780814). The official pytorch/pytorch image has a plain /bin/bash
// entrypoint that Vast.ai's templating handles cleanly.
//
// devel variant chosen over runtime because our buyers commonly
// compile CUDA kernels and need nvcc available. Pulls are ~3GB which
// most verified hosts cache.
export const DEFAULT_VASTAI_IMAGE = 'pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel'

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
  ssh_host?: string | null
  ssh_port?: number | null
  dph_total?: number
  image?: string | null
  geolocation?: string | null
}

/**
 * Cheap sync check. The allocator calls this BEFORE building a request
 * and before any network round trip. Used to short-circuit the Vast.ai
 * fallback when the env isn't fully set, so misconfigured deployments
 * don't show a confusing "Vast.ai didn't respond" error to buyers (they
 * just never see Vast.ai in the cascade).
 */
export function isVastAiConfigured(): boolean {
  return !!process.env.VASTAI_API_KEY?.trim()
}

/**
 * Country codes whose hosts we refuse to book. Driven by VASTAI_REGION_EXCLUDE
 * env var (comma-separated ISO-2 codes, e.g. "CN,RU,IR,KP"). Defaults
 * to the four sanctioned / Great-Firewall-throttled regions where
 * Docker Hub access is unreliable enough to ruin the buyer experience.
 *
 * Real-world failure that motivates this list: rental cmq2vq1nu000 hit
 * a CN host on 2026-06-06 and sat in PROVISIONING_EXTERNAL for 15 HOURS
 * because the Great Firewall stalled the Docker Hub layer pull
 * indefinitely. We burned $2.60 of admin wallet on a dead instance.
 *
 * Filter runs CLIENT-SIDE after listOffers because Vast.ai's /bundles/
 * geolocation query is finicky (their search field is "City, CC" and
 * the `eq` / `nin` operators behave inconsistently across regions).
 * Filtering after the fact is cheap and reliable.
 */
const DEFAULT_EXCLUDED_REGIONS = ['CN', 'RU', 'IR', 'KP']

export function getVastAiExcludedRegions(): string[] {
  const raw = process.env.VASTAI_REGION_EXCLUDE
  if (raw === undefined) return DEFAULT_EXCLUDED_REGIONS
  // Empty string = explicit "disable the filter" override for the
  // operator who wants to accept any verified host.
  if (raw.trim() === '') return []
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

/**
 * Extract the two-letter country code from Vast.ai's geolocation string.
 * Vast.ai stores it as "City, CC" or ", CC" so we take the substring
 * after the last comma and uppercase it. Returns null when the field
 * is null / empty / malformed; caller treats null as "unknown region"
 * and lets it through (don't block on missing data).
 */
export function vastAiCountryCode(geolocation: string | null): string | null {
  if (!geolocation) return null
  const cc = geolocation.split(',').pop()?.trim().toUpperCase()
  if (!cc || cc.length !== 2) return null
  return cc
}

/**
 * True when this host is in a region we refuse to book. Falls through
 * (returns false) when the country code is missing or unknown so a
 * single malformed geolocation can't kill an otherwise-good offer.
 */
export function isVastAiHostExcluded(
  geolocation: string | null,
  excludedRegions: string[] = getVastAiExcludedRegions(),
): boolean {
  const cc = vastAiCountryCode(geolocation)
  if (!cc) return false
  return excludedRegions.includes(cc)
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
      // runtype=ssh tells Vast.ai's startup machinery to expose the
      // container's SSH port via their proxy (ssh1.vast.ai) AND to
      // generate the host SSH keys before our onstart runs. Without
      // this, Vast.ai may default to 'jupyter' mode where SSH is never
      // configured. Vast.ai sometimes infers ssh from the onstart but
      // we set it explicitly to be safe.
      runtype: 'ssh',
      // Vast.ai's onstart script runs once at container start, BEFORE
      // their runtype=ssh machinery kicks in. The official pytorch
      // image does NOT ship openssh-server, so we apt-get install it
      // first (no-op if Vast.ai already installed it). Then write the
      // buyer's ephemeral pubkey (APPEND so we keep any account-level
      // keys Vast.ai pre-installed). Finally try to (re)start sshd; if
      // Vast.ai already started it via runtype=ssh, the restart is a
      // safe no-op. Every step has || true so a flaky apt mirror or
      // already-running sshd can't kill the whole boot. We do NOT
      // block on wait; Vast.ai's entrypoint takes over after onstart
      // returns and keeps the container alive.
      onstart: [
        'apt-get update >/dev/null 2>&1 || true',
        'apt-get install -y --no-install-recommends openssh-server >/dev/null 2>&1 || true',
        'mkdir -p /root/.ssh /var/run/sshd',
        `echo '${args.sshPublicKey.trim()}' >> /root/.ssh/authorized_keys`,
        'chmod 700 /root/.ssh',
        'chmod 600 /root/.ssh/authorized_keys',
        'service ssh restart >/dev/null 2>&1 || /usr/sbin/sshd >/dev/null 2>&1 || true',
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
  // SSH hostname selection: with runtype='ssh' (our default), Vast.ai
  // routes SSH through their proxy at `ssh_host:ssh_port` (e.g.
  // ssh9.vast.ai:19676). The host's `public_ipaddr` is the bare
  // machine IP, but the container's port 22 is NOT exposed there
  // unless the buyer requested direct-port mapping (runtype='ssh_
  // direct' + opened direct_ports). Mapping `public_ipaddr` into
  // publicIpaddr (which the rental UI displays as the SSH host)
  // produces a broken command like `ssh root@76.65.105.169 -p 19676`
  // that mixes the host's direct IP with the proxy's port. Prefer
  // ssh_host, fall back to public_ipaddr only when ssh_host is missing
  // (rare; happens transiently during early boot before Vast.ai has
  // assigned a proxy slot).
  const sshHost = raw.ssh_host ?? raw.public_ipaddr ?? null
  return {
    id: raw.id,
    status,
    gpuName: raw.gpu_name ?? 'UNKNOWN',
    numGpus: raw.num_gpus ?? 1,
    publicIpaddr: sshHost,
    sshPort: typeof raw.ssh_port === 'number' ? raw.ssh_port : null,
    dphTotal: raw.dph_total ?? 0,
    imageName: raw.image ?? null,
    geolocation: raw.geolocation ?? null,
  }
}
