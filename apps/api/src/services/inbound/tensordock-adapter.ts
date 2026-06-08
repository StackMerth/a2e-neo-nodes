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
 * Endpoints (discovered from the caguiclajmg/tensordock-cli Go source,
 * verified by /auth/test 200 OK against the user's account 2026-06-08):
 *
 *   GET  /stock/list                NO AUTH; lists per-(location,model) supply
 *   GET  /list                      auth in query; lists my servers
 *   GET  /get/single?server=<id>    auth + server id; server detail
 *   POST /deploy/single/custom      auth in form body; deploy new server
 *   GET  /delete/single?server=<id> auth + server id; terminate
 *   GET  /stop/single?server=<id>   auth + server id; stop without delete
 *   GET  /start/single?server=<id>  auth + server id; restart stopped
 *   GET  /billing                   auth in query; account balance
 *   POST /auth/test                 auth in form body; credential validity
 *
 * GPU model strings. TensorDock uses lowercase-hyphen format like
 *   h100-sxm5-80gb, a100-sxm4-80gb, geforcertx4090-pcie-24gb
 * The exact catalog is /stock/list's response keys; the probe walks
 * the catalog and matches against tier-mapping substrings rather than
 * hard-coded model strings so SKU rotation doesn't brick the mapping.
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

export interface TensorDockStockEntry {
  available_now: number
  available_reserve: number
}

/**
 * /stock/list returns:
 *   { stock: { "<location>": { "<gpu_model>": { available_now, available_reserve } } } }
 * Locations like "Chicago", "London", model strings like "h100-sxm5-80gb".
 */
export interface TensorDockStockResponse extends TensorDockApiResponse {
  stock: Record<string, Record<string, TensorDockStockEntry>>
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
  links?: Array<Record<string, string>>
  hourly_price?: number
  cost_per_hr?: number
}

export interface TensorDockListServersResponse extends TensorDockApiResponse {
  servers?: Record<string, TensorDockServer>
}

export interface TensorDockGetServerResponse extends TensorDockApiResponse {
  server?: TensorDockServer
}

export interface TensorDockDeployRequest {
  /** Hostname inside the VM (Linux only). */
  name: string
  /** Default user TensorDock creates inside the VM. */
  admin_user: string
  /** Password for admin_user. Required by /deploy/single/custom. */
  admin_pass: string
  /** GPU SKU string from /stock/list, e.g. "h100-sxm5-80gb". */
  gpu_model: string
  /** Number of GPUs of the requested model. */
  gpu_count: number
  /** Total vCPUs. */
  vcpus: number
  /** RAM in GB. */
  ram: number
  /** Storage size in GB. */
  storage: number
  /** "nvme" or "ssd"; defaults to nvme on most hosts. */
  storage_class?: string
  /** OS slug, e.g. "Ubuntu 22.04 LTS". */
  os: string
  /** Location string from /stock/list, e.g. "Chicago". */
  location: string
  /** Internal ports to expose. Defaults to [22] (SSH only) when omitted. */
  internal_ports?: number[]
  /** Optional cloud-init script. */
  cloudinit_script?: string
}

export interface TensorDockDeployResponse extends TensorDockApiResponse {
  server?: {
    id: string
    ip: string
    links?: Array<Record<string, string>>
  }
}

export class TensorDockApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `TensorDock API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'TensorDockApiError'
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

  private authQuery(extra?: Record<string, string>): string {
    const q = new URLSearchParams({ api_key: this.apiKey, api_token: this.apiToken })
    if (extra) for (const [k, v] of Object.entries(extra)) q.set(k, v)
    return q.toString()
  }

  private async getAuth<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}?${this.authQuery(params)}`
    const res = await fetch(url, { method: 'GET' })
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
   * Live inventory across every TensorDock host. UNAUTHENTICATED —
   * doesn't even need a key. Returns shape:
   *   { success, stock: { [location]: { [gpu_model]: { available_now, available_reserve } } } }
   */
  async listStock(): Promise<TensorDockStockResponse> {
    return this.getNoAuth<TensorDockStockResponse>('/stock/list')
  }

  /** List my deployed servers. Returns map keyed by server id. */
  async listServers(): Promise<TensorDockListServersResponse> {
    return this.getAuth<TensorDockListServersResponse>('/list')
  }

  async getServer(serverId: string): Promise<TensorDockGetServerResponse> {
    return this.getAuth<TensorDockGetServerResponse>('/get/single', { server: serverId })
  }

  async deployServer(req: TensorDockDeployRequest): Promise<TensorDockDeployResponse> {
    const fields: Record<string, string | number> = {
      name: req.name,
      admin_user: req.admin_user,
      admin_pass: req.admin_pass,
      gpu_model: req.gpu_model,
      gpu_count: req.gpu_count,
      vcpus: req.vcpus,
      ram: req.ram,
      storage: req.storage,
      os: req.os,
      location: req.location,
    }
    if (req.storage_class) fields.storage_class = req.storage_class
    if (req.internal_ports && req.internal_ports.length > 0) {
      fields.internal_ports = req.internal_ports.join(',')
    }
    if (req.cloudinit_script) fields.cloudinit_script = req.cloudinit_script
    return this.postAuth<TensorDockDeployResponse>('/deploy/single/custom', fields)
  }

  async deleteServer(serverId: string): Promise<TensorDockApiResponse> {
    return this.getAuth<TensorDockApiResponse>('/delete/single', { server: serverId })
  }

  async stopServer(serverId: string): Promise<TensorDockApiResponse> {
    return this.getAuth<TensorDockApiResponse>('/stop/single', { server: serverId })
  }

  async startServer(serverId: string): Promise<TensorDockApiResponse> {
    return this.getAuth<TensorDockApiResponse>('/start/single', { server: serverId })
  }

  async getBilling(): Promise<TensorDockApiResponse & { balance?: number }> {
    return this.getAuth<TensorDockApiResponse & { balance?: number }>('/billing')
  }
}

/**
 * Flatten the stock map into a per-(location, model) row list with the
 * per-location numbers. The cascade probe sums available_now across
 * all locations to decide hasCapacity.
 */
export interface TensorDockStockRow {
  location: string
  gpu_model: string
  available_now: number
  available_reserve: number
}

export function flattenStock(resp: TensorDockStockResponse): TensorDockStockRow[] {
  const rows: TensorDockStockRow[] = []
  for (const [location, byModel] of Object.entries(resp.stock ?? {})) {
    for (const [gpu_model, counts] of Object.entries(byModel ?? {})) {
      rows.push({
        location,
        gpu_model,
        available_now: counts.available_now ?? 0,
        available_reserve: counts.available_reserve ?? 0,
      })
    }
  }
  return rows
}
