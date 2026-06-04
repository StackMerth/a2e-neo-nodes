/**
 * T5g — Google Cloud Compute Engine A3 Confidential VM adapter
 * (inbound supply, confidential GPU compute).
 *
 * Fourth confidential supplier after Phala. GCP A3 Confidential VM
 * (a3-highgpu-1g) is the breakthrough self-serve TDX + Hopper CC
 * supplier identified in the 2026-06-04 research scan: Intel TDX
 * (CPU-side TEE) + NVIDIA H100 Confidential Computing mode (GPU-side
 * TEE) on a single VM, with per-second billing and no daily minimum.
 *
 * Why this matters: the only public-cloud SKU combining (a) Intel TDX
 * + NVIDIA H100 CC, (b) self-serve REST/gcloud API, (c) per-second
 * billing, (d) no email allow-list. Per-second billing means failed
 * provisions cost cents, not $115 like Phala.
 *
 * Auth: OAuth2 client_credentials via service account JWT. The SA
 * key JSON contains client_email + private_key; we sign an RS256
 * JWT and exchange it for a short-lived access token at
 * https://oauth2.googleapis.com/token. Access tokens cache for ~55
 * minutes; we refresh proactively at 59 minutes to avoid clock skew.
 *
 * Status mapping (GCP -> our ExternalRental status):
 *   PROVISIONING / STAGING / REPAIRING -> PENDING
 *   RUNNING                            -> ACTIVE
 *   STOPPING / SUSPENDING              -> CLOSING
 *   STOPPED / SUSPENDED / TERMINATED   -> CLOSED
 *
 * Pricing model:
 *   - a3-highgpu-1g on-demand: ~$10.98/h blended (Apr 2026 reference)
 *   - a3-highgpu-1g spot: ~$3.69/h per GPU (Apr 2026 reference)
 *   - Per-second billing, no minimum
 *   - Confidential premium: typically +5-10% over non-confidential
 *
 * Quota gate:
 *   - Default quota for NVIDIA_H100_GPUS is 0
 *   - User files quota request (1-3 business day approval)
 *   - Adapter calls return 403 PERMISSION_DENIED until quota lands
 *   - We surface that error class so the allocator can skip GCP
 *     gracefully until quota approval
 *
 * SSH model: GCP injects public keys via instance metadata
 *   metadata.items[].key = 'ssh-keys'
 *   metadata.items[].value = 'username:ssh-rsa AAAA...'
 * No per-key registration step on GCP; mirrors Phala/RunPod pattern.
 *
 * Configurability:
 *   GCP_PROJECT_ID   -> required for any live call
 *   GCP_SA_KEY_JSON  -> required, full JSON contents of the service
 *                       account key file (one string, can contain
 *                       newlines that JSON.parse handles)
 *   GCP_API_BASE     -> optional override (defaults to compute.googleapis.com)
 */

import crypto from 'crypto'

const DEFAULT_BASE_URL = 'https://compute.googleapis.com/compute/v1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * Confidential-VM-capable A3 zones as of 2026-06-04 research scan.
 * These are the three zones with a3-highgpu-1g TDX + H100 CC capacity.
 * Adapter rotates through these on capacity errors.
 */
export const GCP_A3_CONFIDENTIAL_ZONES = [
  'europe-west4-c',
  'us-central1-a',
  'us-east5-a',
] as const

/**
 * Default boot image family for TDX + H100 CC A3 instances. Must be
 * a confidential-VM-capable image that includes NVIDIA driver support
 * for Hopper CC mode. GCP curates `confidential-vm-images` for the
 * TDX side; for the CC-mode-aware GPU drivers we currently rely on
 * the cuda-installed family. This is iterable — first provision
 * test will reveal if the default image works or needs a swap.
 */
export const GCP_A3_DEFAULT_IMAGE =
  'projects/confidential-vm-images/global/images/family/ubuntu-2204-lts-confidential-tdx'

export class GcpApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `GCP API ${endpoint} returned ${statusCode}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    )
    this.name = 'GcpApiError'
  }
}

/** Service account JSON key shape — only the fields we use are typed. */
interface ServiceAccountKey {
  type: 'service_account'
  project_id: string
  private_key_id: string
  private_key: string
  client_email: string
  client_id: string
}

export type GcpInstanceStatus =
  | 'PROVISIONING'
  | 'STAGING'
  | 'RUNNING'
  | 'STOPPING'
  | 'SUSPENDING'
  | 'SUSPENDED'
  | 'STOPPED'
  | 'TERMINATED'
  | 'REPAIRING'

export interface GcpInstance {
  /** GCP instance name (also used as id within zone scope). */
  name: string
  /** GCP also returns a numeric id but we use name as canonical. */
  id: string
  zone: string
  status: GcpInstanceStatus
  /** External NAT IP, populated once status=RUNNING. */
  publicIp: string | null
  /** Internal subnet IP, populated earlier than publicIp. */
  privateIp: string | null
  /** Machine type short name (e.g. "a3-highgpu-1g"). */
  machineType: string
  /** Spot/preemptible vs standard. */
  spot: boolean
  /** ISO timestamp from GCP. */
  createdAt: string | null
}

export interface CreateGcpInstanceArgs {
  /** Buyer-facing name; appears in GCP console. Max 63 chars, lowercase + digits + hyphens. */
  name: string
  /** Zone for provisioning. Pick from GCP_A3_CONFIDENTIAL_ZONES. */
  zone: string
  /** Machine type short name, e.g. "a3-highgpu-1g". */
  machineType: string
  /** SSH public key in OpenSSH format. Injected as instance metadata. */
  sshPublicKey: string
  /** SSH username; GCP convention is whatever Linux user the image creates. Default 'ubuntu'. */
  sshUsername?: string
  /** Boot disk size in GB. Default 100 (A3 confidential needs space for CUDA + container layers). */
  diskSizeGb?: number
  /** Override the default boot image family. */
  imageSource?: string
  /** Use spot/preemptible tier for ~70% cost reduction. Default false (on-demand). */
  spot?: boolean
}

/**
 * Result of POST /instances. GCP returns an Operation, NOT the
 * instance directly. Caller waits for the operation to complete or
 * polls the instance separately. We return both the eventual instance
 * name (we set it at create time) and the operation name so callers
 * can wait on it if needed.
 */
export interface CreateGcpInstanceResult {
  instanceName: string
  operationName: string
  zone: string
}

export function isGcpConfigured(): boolean {
  return (
    Boolean(process.env.GCP_PROJECT_ID?.trim()) &&
    Boolean(process.env.GCP_SA_KEY_JSON?.trim())
  )
}

/**
 * Compute Engine REST client. One instance per process is fine; the
 * cached access token is shared across method calls.
 */
export class GcpClient {
  private readonly base: string
  private readonly projectId: string
  private readonly saKey: ServiceAccountKey
  private tokenCache: { token: string; expiresAt: number } | null = null

  constructor(opts?: { projectId?: string; saKeyJson?: string; baseUrl?: string }) {
    const projectId = (opts?.projectId ?? process.env.GCP_PROJECT_ID ?? '').trim()
    const saKeyRaw = (opts?.saKeyJson ?? process.env.GCP_SA_KEY_JSON ?? '').trim()
    if (!projectId) {
      throw new Error('GcpClient requires GCP_PROJECT_ID env var or projectId opt.')
    }
    if (!saKeyRaw) {
      throw new Error('GcpClient requires GCP_SA_KEY_JSON env var or saKeyJson opt.')
    }

    let parsed: ServiceAccountKey
    try {
      parsed = JSON.parse(saKeyRaw)
    } catch (err) {
      throw new Error(
        `GCP_SA_KEY_JSON is not valid JSON: ${(err as Error).message}`,
      )
    }
    if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
      throw new Error(
        'GCP_SA_KEY_JSON is missing required fields (type, private_key, client_email).',
      )
    }

    this.projectId = projectId
    this.saKey = parsed
    this.base = (opts?.baseUrl ?? process.env.GCP_API_BASE ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
  }

  /**
   * Sign a JWT with the service account private key and exchange it
   * for an OAuth2 access token. Tokens last 3600s; we cache for ~3540s
   * to leave 60s of clock-skew margin.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token
    }

    const nowSec = Math.floor(now / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    const claim = {
      iss: this.saKey.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      exp: nowSec + 3600,
      iat: nowSec,
    }

    const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)))
    const claimB64 = base64UrlEncode(Buffer.from(JSON.stringify(claim)))
    const signingInput = `${headerB64}.${claimB64}`

    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.saKey.private_key)
    const signatureB64 = base64UrlEncode(signature)
    const jwt = `${signingInput}.${signatureB64}`

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
    })

    const text = await res.text()
    if (!res.ok) {
      throw new GcpApiError(res.status, TOKEN_URL, text)
    }
    const data = JSON.parse(text) as { access_token: string; expires_in: number }
    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + data.expires_in * 1000 - 60_000,
    }
    return data.access_token
  }

  /**
   * List the zones in this project that currently report A3 capacity
   * for confidential provisioning. We rely on the zones constant for
   * Phase 1 since GCP's machine-type listing doesn't expose live
   * capacity. createInstance returns a clear error on capacity issues
   * and the allocator rotates zones.
   */
  listA3Zones(): readonly string[] {
    return GCP_A3_CONFIDENTIAL_ZONES
  }

  /**
   * Create a confidential A3 instance. Returns the operation name
   * so the caller can poll it (or just poll the instance directly).
   *
   * Confidential A3 requires:
   *   - confidentialInstanceConfig with TDX + enableConfidentialCompute
   *   - Compatible boot image (defaults to confidential-vm-images TDX family)
   *   - shieldedInstanceConfig with vTPM + integrity monitoring
   *   - onHostMaintenance=TERMINATE (live migration isn't supported for TEE)
   */
  async createInstance(args: CreateGcpInstanceArgs): Promise<CreateGcpInstanceResult> {
    const zone = args.zone
    const path = `/projects/${this.projectId}/zones/${zone}/instances`
    const sshUser = (args.sshUsername ?? 'ubuntu').trim()
    const sshKey = args.sshPublicKey.trim()

    const body = {
      name: args.name,
      machineType: `zones/${zone}/machineTypes/${args.machineType}`,
      scheduling: {
        provisioningModel: args.spot ? 'SPOT' : 'STANDARD',
        preemptible: Boolean(args.spot),
        onHostMaintenance: 'TERMINATE',
        automaticRestart: false,
      },
      confidentialInstanceConfig: {
        enableConfidentialCompute: true,
        confidentialInstanceType: 'TDX',
      },
      shieldedInstanceConfig: {
        enableVtpm: true,
        enableIntegrityMonitoring: true,
      },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: args.imageSource ?? GCP_A3_DEFAULT_IMAGE,
            diskSizeGb: String(args.diskSizeGb ?? 100),
          },
        },
      ],
      networkInterfaces: [
        {
          network: 'global/networks/default',
          accessConfigs: [
            { type: 'ONE_TO_ONE_NAT', name: 'External NAT' },
          ],
        },
      ],
      metadata: {
        items: [
          {
            key: 'ssh-keys',
            value: `${sshUser}:${sshKey}`,
          },
        ],
      },
    }

    const op = await this.request<RawOperation>(path, 'POST', body)
    return {
      instanceName: args.name,
      operationName: op.name,
      zone,
    }
  }

  /**
   * Poll a specific instance. Returns the full instance record
   * including current status + IP + machine type.
   */
  async getInstance(zone: string, name: string): Promise<GcpInstance> {
    const path = `/projects/${this.projectId}/zones/${zone}/instances/${encodeURIComponent(name)}`
    const raw = await this.request<RawInstance>(path, 'GET')
    return normalizeInstance(raw, zone)
  }

  /**
   * Delete an instance. Idempotent on 404. GCP DELETE returns an
   * Operation; we don't wait for it (the caller's poll loop will
   * eventually see status=TERMINATED then 404).
   */
  async deleteInstance(zone: string, name: string): Promise<void> {
    const path = `/projects/${this.projectId}/zones/${zone}/instances/${encodeURIComponent(name)}`
    try {
      await this.request<unknown>(path, 'DELETE')
    } catch (err) {
      if (err instanceof GcpApiError && err.statusCode === 404) return
      throw err
    }
  }

  /**
   * Poll a zone-scoped operation until it reports done. Useful for
   * blocking on instance-create completion (status should reach
   * RUNNING shortly after).
   *
   * timeoutMs is a soft cap; raises if the operation is still
   * RUNNING/PENDING after the budget. Default 240s for A3
   * confidential boot (TEE attestation handshake adds ~30-60s).
   */
  async waitForOperation(
    zone: string,
    operationName: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<RawOperation> {
    const timeoutMs = opts.timeoutMs ?? 240_000
    const pollIntervalMs = opts.pollIntervalMs ?? 4000
    const deadline = Date.now() + timeoutMs
    const path = `/projects/${this.projectId}/zones/${zone}/operations/${encodeURIComponent(operationName)}`
    while (Date.now() < deadline) {
      const op = await this.request<RawOperation>(path, 'GET')
      if (op.status === 'DONE') {
        if (op.error) {
          throw new GcpApiError(
            500,
            path,
            `Operation failed: ${JSON.stringify(op.error)}`,
          )
        }
        return op
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
    throw new GcpApiError(
      408,
      path,
      `Operation ${operationName} did not complete within ${timeoutMs}ms`,
    )
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const token = await this.getAccessToken()
    const url = `${this.base}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
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
      throw new GcpApiError(res.status, path, parsed ?? text)
    }
    return parsed as T
  }
}

// ---- Raw response shapes (GCP Compute v1) ----

interface RawOperation {
  kind: string
  id: string
  name: string
  zone?: string
  operationType: string
  targetLink: string
  targetId: string
  status: 'PENDING' | 'RUNNING' | 'DONE'
  user?: string
  progress?: number
  insertTime?: string
  startTime?: string
  endTime?: string
  error?: {
    errors?: Array<{ code?: string; location?: string; message?: string }>
  }
}

interface RawInstance {
  id: string
  name: string
  zone: string // full URL
  status: GcpInstanceStatus
  statusMessage?: string
  machineType: string // full URL
  creationTimestamp?: string
  scheduling?: {
    provisioningModel?: 'STANDARD' | 'SPOT'
    preemptible?: boolean
  }
  networkInterfaces?: Array<{
    networkIP?: string
    accessConfigs?: Array<{
      natIP?: string
      type?: string
    }>
  }>
  confidentialInstanceConfig?: {
    enableConfidentialCompute?: boolean
    confidentialInstanceType?: 'TDX' | 'SEV' | 'SEV_SNP'
  }
}

function normalizeInstance(raw: RawInstance, zone: string): GcpInstance {
  // GCP returns full URL paths for zone and machineType; strip to short name.
  const machineTypeShort = raw.machineType?.split('/').pop() ?? 'unknown'
  let publicIp: string | null = null
  let privateIp: string | null = null
  if (Array.isArray(raw.networkInterfaces)) {
    for (const nic of raw.networkInterfaces) {
      if (!privateIp && nic.networkIP) privateIp = nic.networkIP
      if (!publicIp && Array.isArray(nic.accessConfigs)) {
        for (const ac of nic.accessConfigs) {
          if (ac.natIP) {
            publicIp = ac.natIP
            break
          }
        }
      }
    }
  }
  return {
    name: raw.name,
    id: raw.id,
    zone,
    status: raw.status,
    publicIp,
    privateIp,
    machineType: machineTypeShort,
    spot: raw.scheduling?.preemptible === true || raw.scheduling?.provisioningModel === 'SPOT',
    createdAt: raw.creationTimestamp ?? null,
  }
}

/** RFC 4648 base64url (no padding) — required for JWT encoding. */
function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
