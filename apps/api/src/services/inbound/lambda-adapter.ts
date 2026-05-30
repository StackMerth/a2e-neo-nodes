/**
 * T4 — Lambda Labs Cloud API adapter (inbound supply).
 *
 * When a buyer rents an instance type our internal node pool can't
 * serve, the allocator falls through to Lambda Labs and provisions
 * a fresh instance from their pool. The buyer gets SSH into a real
 * GPU within ~60 seconds; we pay Lambda per-second and split the
 * marked-up gross 3 ways via splitRevenue.
 *
 * This module is the THIN client. It wraps Lambda's REST surface with
 * typed methods and turns non-2xx responses into a typed error class.
 * Business logic (allocator routing, ExternalRental row, SSH-key
 * lifecycle per rental) lives in T5.
 *
 * Auth: HTTP Basic where the API key is the username and password is
 * empty. Lambda's API docs confirm this is the only auth scheme; do
 * NOT switch to Bearer — older accounts reject it.
 *
 * Status mapping (Lambda -> our world):
 *   booting     -> PENDING   (instance launched, OS coming up)
 *   active      -> READY     (SSH listening; buyer can connect)
 *   unhealthy   -> DEGRADED  (instance up but Lambda reports a fault)
 *   terminating -> CLOSING   (buyer or operator triggered terminate)
 *   terminated  -> CLOSED    (fully released, no further billing)
 *
 * Error handling: every public method returns a Promise that rejects
 * with LambdaApiError on non-2xx so the caller can branch on
 * statusCode (e.g. 429 -> backoff, 404 -> already-terminated, etc.).
 * Network failures bubble up as ordinary Error.
 *
 * Configurability:
 *   LAMBDA_API_KEY   -> required for any live call
 *   LAMBDA_API_BASE  -> optional override (defaults to prod URL)
 * isLambdaConfigured() is a cheap synchronous check the allocator
 * uses to decide whether to even attempt the fallback.
 */

const DEFAULT_BASE_URL = 'https://cloud.lambdalabs.com/api/v1'

export class LambdaApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `Lambda API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'LambdaApiError'
  }
}

/**
 * Subset of Lambda's instance type record we care about. Keys mirror
 * the upstream JSON exactly so a snapshot of their response can be
 * passed in without renaming.
 */
export interface LambdaInstanceType {
  name: string
  description: string
  gpuDescription: string
  pricePerHourUsd: number
  specs: {
    vcpus: number
    memoryGib: number
    storageGib: number
    gpus: number
  }
  /** Region codes where this type currently has capacity. */
  regionsAvailable: string[]
}

export type LambdaInstanceStatus =
  | 'booting'
  | 'active'
  | 'unhealthy'
  | 'terminating'
  | 'terminated'

export interface LambdaInstance {
  id: string
  name: string | null
  /** IPv4 reachable on port 22 when status is 'active'. */
  ip: string | null
  status: LambdaInstanceStatus
  region: string
  instanceTypeName: string
  sshKeyNames: string[]
  pricePerHourUsd: number | null
  /** ISO timestamp Lambda reports for when billing started. */
  createdAt: string | null
}

export interface LambdaSshKey {
  id: string
  name: string
  publicKey: string
}

export interface LaunchInstanceArgs {
  region: string
  instanceTypeName: string
  /**
   * Names of SSH keys that must already exist on the Lambda account
   * (see addSshKey). Lambda installs their public keys in the new
   * instance's authorized_keys at boot. Most callers will pass a
   * single per-rental key generated in T5.
   */
  sshKeyNames: string[]
  /** Friendly label that shows up in the Lambda console. Optional. */
  name?: string
  /** Optional list of file system names to mount. Rare for our use case. */
  fileSystemNames?: string[]
  /** Number of identical instances to launch. Defaults to 1. */
  quantity?: number
}

interface RawInstanceTypesResponse {
  data: Record<
    string,
    {
      instance_type: {
        name: string
        description?: string
        gpu_description?: string
        price_cents_per_hour: number
        specs?: {
          vcpus?: number
          memory_gib?: number
          storage_gib?: number
          gpus?: number
        }
      }
      regions_with_capacity_available: Array<{ name: string }>
    }
  >
}

interface RawInstance {
  id: string
  name?: string | null
  ip?: string | null
  status: LambdaInstanceStatus
  ssh_key_names?: string[]
  region?: { name: string }
  instance_type?: { name: string; price_cents_per_hour?: number }
  created_at?: string
}

interface RawSshKey {
  id: string
  name: string
  public_key: string
}

export function isLambdaConfigured(): boolean {
  return Boolean(process.env.LAMBDA_API_KEY?.trim())
}

export class LambdaClient {
  private readonly base: string
  private readonly authHeader: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.LAMBDA_API_KEY ?? '').trim()
    if (!key) {
      throw new Error(
        'LambdaClient requires LAMBDA_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.base = (baseUrl ?? process.env.LAMBDA_API_BASE ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
    // Lambda uses HTTP Basic: api key as user, blank password.
    this.authHeader = 'Basic ' + Buffer.from(`${key}:`).toString('base64')
  }

  /**
   * GET /instance-types — return every instance type with its current
   * regional capacity. Buyers see what's available before they rent.
   */
  async listInstanceTypes(): Promise<LambdaInstanceType[]> {
    const raw = await this.request<RawInstanceTypesResponse>('/instance-types', 'GET')
    const out: LambdaInstanceType[] = []
    for (const entry of Object.values(raw.data)) {
      const t = entry.instance_type
      out.push({
        name: t.name,
        description: t.description ?? '',
        gpuDescription: t.gpu_description ?? '',
        pricePerHourUsd: t.price_cents_per_hour / 100,
        specs: {
          vcpus: t.specs?.vcpus ?? 0,
          memoryGib: t.specs?.memory_gib ?? 0,
          storageGib: t.specs?.storage_gib ?? 0,
          gpus: t.specs?.gpus ?? 0,
        },
        regionsAvailable: entry.regions_with_capacity_available.map((r) => r.name),
      })
    }
    return out
  }

  /**
   * GET /instances — list every instance Lambda is currently billing
   * for on the configured account. Useful for the inspector and for
   * orphan-reconciliation (an ExternalRental row should never live
   * without a matching Lambda instance).
   */
  async listInstances(): Promise<LambdaInstance[]> {
    const raw = await this.request<{ data: RawInstance[] }>('/instances', 'GET')
    return raw.data.map(normalizeInstance)
  }

  /**
   * GET /instances/{id} — poll status during the boot window. The
   * allocator wakes up every ~5s while a rental is PENDING and waits
   * for status='active'.
   */
  async getInstance(id: string): Promise<LambdaInstance> {
    const raw = await this.request<{ data: RawInstance }>(
      `/instances/${encodeURIComponent(id)}`,
      'GET',
    )
    return normalizeInstance(raw.data)
  }

  /**
   * POST /instance-operations/launch — provision and start billing.
   * Returns the new instance ids; statuses begin as 'booting' and
   * flip to 'active' once Lambda's image finishes init (~30-90s).
   */
  async launchInstance(args: LaunchInstanceArgs): Promise<string[]> {
    const body = {
      region_name: args.region,
      instance_type_name: args.instanceTypeName,
      ssh_key_names: args.sshKeyNames,
      name: args.name,
      file_system_names: args.fileSystemNames ?? [],
      quantity: args.quantity ?? 1,
    }
    const raw = await this.request<{ data: { instance_ids: string[] } }>(
      '/instance-operations/launch',
      'POST',
      body,
    )
    return raw.data.instance_ids
  }

  /**
   * POST /instance-operations/terminate — stop billing on the
   * specified instances. Idempotent on Lambda's side (already-
   * terminated instance ids are silently skipped), but throws on
   * unknown ids (404) so the caller can flag stale ExternalRental
   * rows.
   */
  async terminateInstances(instanceIds: string[]): Promise<void> {
    if (instanceIds.length === 0) return
    await this.request<unknown>(
      '/instance-operations/terminate',
      'POST',
      { instance_ids: instanceIds },
    )
  }

  /**
   * GET /ssh-keys — list keys registered on the Lambda account.
   * Lambda enforces uniqueness on the key NAME; addSshKey will reject
   * duplicates. T5 uses this to dedup before adding a per-rental key.
   */
  async listSshKeys(): Promise<LambdaSshKey[]> {
    const raw = await this.request<{ data: RawSshKey[] }>('/ssh-keys', 'GET')
    return raw.data.map((k) => ({
      id: k.id,
      name: k.name,
      publicKey: k.public_key,
    }))
  }

  /**
   * POST /ssh-keys — register a new key. Returns the key's id which
   * we store on the ExternalRental row so terminate can clean up
   * after the rental ends. Per Lambda's API, the name must be unique
   * across the entire account; T5 namespaces by rental id.
   */
  async addSshKey(name: string, publicKey: string): Promise<LambdaSshKey> {
    const raw = await this.request<{ data: RawSshKey }>(
      '/ssh-keys',
      'POST',
      { name, public_key: publicKey },
    )
    return {
      id: raw.data.id,
      name: raw.data.name,
      publicKey: raw.data.public_key,
    }
  }

  /**
   * DELETE /ssh-keys/{id} — remove a registered key. Called after a
   * rental terminates so we don't leave per-rental key clutter on
   * the Lambda account. Tolerates 404 silently (idempotent cleanup).
   */
  async deleteSshKey(id: string): Promise<void> {
    try {
      await this.request<unknown>(`/ssh-keys/${encodeURIComponent(id)}`, 'DELETE')
    } catch (err) {
      if (err instanceof LambdaApiError && err.statusCode === 404) return
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
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    let parsed: unknown = undefined
    const text = await res.text()
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!res.ok) {
      throw new LambdaApiError(res.status, `${method} ${path}`, parsed)
    }
    return parsed as T
  }
}

function normalizeInstance(raw: RawInstance): LambdaInstance {
  return {
    id: raw.id,
    name: raw.name ?? null,
    ip: raw.ip ?? null,
    status: raw.status,
    region: raw.region?.name ?? 'unknown',
    instanceTypeName: raw.instance_type?.name ?? 'unknown',
    sshKeyNames: raw.ssh_key_names ?? [],
    pricePerHourUsd:
      typeof raw.instance_type?.price_cents_per_hour === 'number'
        ? raw.instance_type.price_cents_per_hour / 100
        : null,
    createdAt: raw.created_at ?? null,
  }
}
