/**
 * TensorDock REST adapter (inbound supply, eighth provider).
 *
 * Why TensorDock. Peer-to-peer GPU marketplace similar in shape to
 * Vast.ai but with a smaller, often more reliable host pool plus
 * datacenter-grade SKUs (H100 SXM5, A100, L40S) alongside consumer
 * cards (4090, 3090). Per the 2026-06-07 supply audit, TensorDock is
 * NOT aggregated by Shadeform, so this direct adapter is the only way
 * the cascade reaches their inventory.
 *
 * REST API.
 *   Base:   https://marketplace.tensordock.com/api/v0
 *   Auth:   api_key + api_token form fields (POST) or query params (GET).
 *           api_key = Authorization ID (UUID, returned at auth creation)
 *           api_token = API Token (alphanumeric secret, shown once)
 *   Docs:   https://documenter.getpostman.com/view/20973002/2s8YzMYRDc
 *
 * Endpoints (ground truth recovered from alx/tensordock_deploy main.py,
 * verified by /auth/test 200 OK against the user's account 2026-06-08;
 * the older caguiclajmg/tensordock-cli Go source had stale paths):
 *
 *   POST /auth/test                       form body; credential check
 *   GET  /client/deploy/hostnodes         NO AUTH; lists hosts + per-host
 *                                          (specs.gpu, location, status)
 *   POST /client/deploy/single            form body + hostnode id; deploy
 *   POST /client/list                     form body; lists my servers
 *                                          (returns { virtualmachines })
 *   POST /client/get/single               form body + server; server detail
 *   POST /client/delete/single            form body + server; terminate
 *
 * GPU model strings. TensorDock uses lowercase short slugs in
 * specs.gpu keys ("rtx3090", "a100", "h100-sxm5-80gb"). The probe
 * walks the hostnodes catalog and matches against tier substring
 * patterns rather than hard-coded model strings so SKU rotation
 * doesn't brick the mapping.
 *
 * Status mapping (TensorDock -> our world).
 *   pending / installing      -> PENDING
 *   running                   -> READY
 *   stopped                   -> DEGRADED (rentable but not running)
 *   terminated / deleted      -> CLOSED
 *
 * Configurability.
 *   TENSORDOCK_API_KEY              Authorization ID (UUID)
 *   TENSORDOCK_API_TOKEN            API Token (the secret)
 *   TENSORDOCK_API_BASE             optional URL override
 *   TENSORDOCK_ALLOCATOR_ENABLED    'false' to exclude from cascade.
 *                                   Default true (master-switch
 *                                   philosophy).
 *
 * Note on credential rotation: TensorDock tokens are shown ONCE at
 * creation. If TENSORDOCK_API_TOKEN env was leaked (e.g. pasted into a
 * log or chat), revoke the authorization in the dashboard and create
 * a fresh one. There's no "rotate token" path; revoke is the only fix.
 */

const DEFAULT_BASE_URL = 'https://marketplace.tensordock.com/api/v0'

export interface TensorDockApiResponse {
  success: boolean
  error?: string
}

/**
 * Per-resource fields TensorDock surfaces under `specs.<resource>`.
 * The "amount" is the total installed; "price" is per-unit if present.
 */
export interface TensorDockSpecResource {
  amount: number
  price?: number
}

/**
 * Per-host GPU slot in specs.gpu: { "rtx3090": { amount: 8, price: 0.31, ... } }
 * The keys are model slugs we match against tier substring patterns.
 */
export interface TensorDockGpuSlot extends TensorDockSpecResource {}

export interface TensorDockHostNode {
  status?: { online?: boolean; reserved?: boolean }
  location?: { city?: string; region?: string; country?: string }
  specs?: {
    cpu?: TensorDockSpecResource & { type?: string }
    ram?: TensorDockSpecResource
    storage?: TensorDockSpecResource
    gpu?: Record<string, TensorDockGpuSlot>
  }
  networking?: {
    ports?: number[]
  }
}

/**
 * GET /api/v0/client/deploy/hostnodes returns:
 *   { hostnodes: { "<host_id>": HostNode } }
 * No "success" envelope on this endpoint (unauthenticated read).
 */
export interface TensorDockHostNodesResponse {
  hostnodes?: Record<string, TensorDockHostNode>
}

export interface TensorDockServer {
  id?: string
  status?: string
  gpu_model?: string
  gpu_count?: number
  ram?: number
  vcpus?: number
  storage?: number
  os?: string
  location?: string
  ip?: string | null
  port_forwards?: Record<string, number>
  hourly_price?: number
  cost_per_hr?: number
}

export interface TensorDockListServersResponse extends TensorDockApiResponse {
  /** Map of server UUID -> server payload. Per /client/list shape. */
  virtualmachines?: Record<string, TensorDockServer>
}

export interface TensorDockGetServerResponse extends TensorDockApiResponse {
  server?: TensorDockServer
}

export interface TensorDockDeployRequest {
  /** Hostname inside the VM (Linux only). */
  name: string
  /** Root password. Required even when ssh_key is set; some hosts force a password regardless. */
  password: string
  /**
   * SSH public key (openssh format). TensorDock's native field for key
   * injection at provision time. Use this instead of cloudinit_script
   * for SSH; cloud-init parsing has been observed to silently 500 on
   * standard formats.
   */
  ssh_key?: string
  /** Host UUID from /client/deploy/hostnodes (hostnodes[uuid]). */
  hostnode: string
  /** GPU model slug as it appears under specs.gpu of the host, e.g. "rtx3090". */
  gpu_model: string
  /** Number of GPUs of the requested model. */
  gpu_count: number
  /** Total vCPUs. */
  vcpus: number
  /** RAM in GB. */
  ram: number
  /** Storage size in GB. */
  storage: number
  /** OS slug, e.g. "Ubuntu 22.04 LTS". */
  operating_system: string
  /** Internal ports the VM listens on. Defaults to [22] when omitted. */
  internal_ports?: number[]
  /** External ports the host exposes; must be a subset of host.networking.ports. */
  external_ports?: number[]
  /** Optional cloud-init script content. Prefer ssh_key field for SSH access. */
  cloudinit_script?: string
}

export interface TensorDockDeployResponse extends TensorDockApiResponse {
  /** Public IP after deploy completes. */
  ip?: string
  /** Map of host-side external port -> VM-side internal port. */
  port_forwards?: Record<string, number>
  /** Server UUID; some responses return it as `server` or `id`. */
  server?: string | { id?: string; ip?: string }
}

export class TensorDockApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    // Truncate aggressively in the .message preview so the log line
    // stays scannable, but stash the full body on the instance for the
    // caller to inspect. The 500 HTML pages TensorDock returns are
    // multi-kb traceback dumps that bury the actual cause when shown
    // inline.
    const preview = TensorDockApiError.summarize(body)
    super(
      `TensorDock API ${endpoint} returned ${statusCode}: ${preview}`,
    )
    this.name = 'TensorDockApiError'
  }

  static summarize(body: unknown): string {
    if (typeof body === 'string') {
      // HTML 5xx pages from Flask have a <title> with the actual error
      // class + message; surface that as the preview.
      const titleMatch = body.match(/<title>([^<]+)<\/title>/i)
      if (titleMatch) return `[html] ${titleMatch[1]!.trim()}`
      // Plain text or short JSON-as-string: keep first 200 chars.
      return body.slice(0, 200)
    }
    try {
      return JSON.stringify(body).slice(0, 300)
    } catch {
      return '[unserializable body]'
    }
  }
}

export function isTensorDockConfigured(): boolean {
  return !!process.env.TENSORDOCK_API_KEY?.trim() && !!process.env.TENSORDOCK_API_TOKEN?.trim()
}

export function isTensorDockAllocatorEnabled(): boolean {
  return process.env.TENSORDOCK_ALLOCATOR_ENABLED?.toLowerCase() !== 'false'
}

export class TensorDockClient {
  private baseUrl: string
  private apiKey: string
  private apiToken: string

  constructor(opts?: { apiKey?: string; apiToken?: string; baseUrl?: string }) {
    const key = (opts?.apiKey ?? process.env.TENSORDOCK_API_KEY)?.trim()
    const tok = (opts?.apiToken ?? process.env.TENSORDOCK_API_TOKEN)?.trim()
    if (!key || !tok) {
      throw new Error(
        'TensorDockClient requires TENSORDOCK_API_KEY (Authorization ID UUID) + TENSORDOCK_API_TOKEN (API Token secret).',
      )
    }
    this.apiKey = key
    this.apiToken = tok
    this.baseUrl = (opts?.baseUrl ?? process.env.TENSORDOCK_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  /**
   * Bare GET that doesn't include auth in the query. Used for
   * unauthenticated endpoints like /stock/list which return inventory
   * without requiring credentials.
   */
  private async getNoAuth<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'GET' })
    if (!res.ok) {
      let parsed: unknown = await res.text()
      try { parsed = JSON.parse(parsed as string) } catch { /* keep raw */ }
      throw new TensorDockApiError(res.status, path, parsed)
    }
    return (await res.json()) as T
  }

  private async postAuth<T>(path: string, fields: Record<string, string | number | boolean>): Promise<T> {
    const body = new URLSearchParams()
    body.set('api_key', this.apiKey)
    body.set('api_token', this.apiToken)
    for (const [k, v] of Object.entries(fields)) body.set(k, String(v))
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      let parsed: unknown = await res.text()
      try { parsed = JSON.parse(parsed as string) } catch { /* keep raw */ }
      throw new TensorDockApiError(res.status, path, parsed)
    }
    return (await res.json()) as T
  }

  /**
   * Confirm the (api_key, api_token) pair is valid without doing any
   * destructive action. Returns { success: true } on success.
   */
  async authTest(): Promise<TensorDockApiResponse> {
    return this.postAuth<TensorDockApiResponse>('/auth/test', {})
  }

  /**
   * Live host inventory. UNAUTHENTICATED — no key required. Returns
   *   { hostnodes: { <host_id>: { status, location, specs, networking } } }
   * specs.gpu is a map of GPU model slug -> { amount, price, ... }.
   */
  async listHostNodes(): Promise<TensorDockHostNodesResponse> {
    return this.getNoAuth<TensorDockHostNodesResponse>('/client/deploy/hostnodes')
  }

  /** List my deployed servers. Returns map keyed by server UUID under `virtualmachines`. */
  async listServers(): Promise<TensorDockListServersResponse> {
    return this.postAuth<TensorDockListServersResponse>('/client/list', {})
  }

  async getServer(serverId: string): Promise<TensorDockGetServerResponse> {
    return this.postAuth<TensorDockGetServerResponse>('/client/get/single', { server: serverId })
  }

  async deployServer(req: TensorDockDeployRequest): Promise<TensorDockDeployResponse> {
    const fields: Record<string, string | number> = {
      name: req.name,
      password: req.password,
      hostnode: req.hostnode,
      gpu_model: req.gpu_model,
      gpu_count: req.gpu_count,
      vcpus: req.vcpus,
      ram: req.ram,
      storage: req.storage,
      operating_system: req.operating_system,
    }
    if (req.ssh_key) fields.ssh_key = req.ssh_key
    // TensorDock expects external_ports and internal_ports as
    // python-set string repr like "{22, 8888}". The deploy script
    // sends literally `str(set([22, 8888]))`; we emulate that by
    // wrapping the joined list in braces.
    if (req.internal_ports && req.internal_ports.length > 0) {
      fields.internal_ports = `{${req.internal_ports.join(', ')}}`
    }
    if (req.external_ports && req.external_ports.length > 0) {
      fields.external_ports = `{${req.external_ports.join(', ')}}`
    }
    if (req.cloudinit_script) fields.cloudinit_script = req.cloudinit_script
    return this.postAuth<TensorDockDeployResponse>('/client/deploy/single', fields)
  }

  async deleteServer(serverId: string): Promise<TensorDockApiResponse> {
    return this.postAuth<TensorDockApiResponse>('/client/delete/single', { server: serverId })
  }

  async stopServer(serverId: string): Promise<TensorDockApiResponse> {
    return this.postAuth<TensorDockApiResponse>('/client/stop/single', { server: serverId })
  }

  async startServer(serverId: string): Promise<TensorDockApiResponse> {
    return this.postAuth<TensorDockApiResponse>('/client/start/single', { server: serverId })
  }
}

/**
 * Per-host per-GPU row, flattened from /client/deploy/hostnodes. The
 * capacity probe iterates these, filters by tier substring match, and
 * sums `amount` per matching row.
 */
export interface TensorDockHostGpuRow {
  hostId: string
  online: boolean
  country: string
  city: string | null
  gpu_model: string
  /** Cards installed on the host for this model. */
  amount: number
  /** Per-card per-hour USD; absent when host doesn't expose it. */
  price?: number
  /**
   * Host's pre-allocated external port pool. /client/deploy/single's
   * external_ports MUST be a subset of these; passing arbitrary ports
   * triggers a server-side 500. Empty list = no free ports on host.
   */
  availableExternalPorts: number[]
}

export function flattenHostNodes(resp: TensorDockHostNodesResponse): TensorDockHostGpuRow[] {
  const rows: TensorDockHostGpuRow[] = []
  for (const [hostId, host] of Object.entries(resp.hostnodes ?? {})) {
    const online = host.status?.online === true
    const country = host.location?.country ?? 'unknown'
    const city = host.location?.city ?? null
    const ports = Array.isArray(host.networking?.ports) ? host.networking!.ports! : []
    for (const [gpu_model, slot] of Object.entries(host.specs?.gpu ?? {})) {
      const amount = Number(slot?.amount ?? 0)
      if (!Number.isFinite(amount) || amount <= 0) continue
      rows.push({
        hostId,
        online,
        country,
        city,
        gpu_model,
        amount,
        price: typeof slot?.price === 'number' ? slot.price : undefined,
        availableExternalPorts: ports,
      })
    }
  }
  return rows
}
