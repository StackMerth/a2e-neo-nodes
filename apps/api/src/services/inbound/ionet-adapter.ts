/**
 * T5g / Phase 2 — io.net VMaaS API adapter (inbound supply).
 *
 * Fourth inbound provider after Lambda + RunPod + Phala (parked).
 * io.net targets the same confidential compute requirement as Phala
 * (Intel TDX + NVIDIA Hopper CC mode), but via a clean REST API that
 * mirrors our existing Lambda/RunPod adapter shape much better.
 *
 * IMPORTANT — confidential SKU access (2026-06-03):
 *   io.net's confidential compute path is currently EMAIL-GATED at
 *   business@io.net (same pattern as Phala, just better-documented).
 *   The public VMaaS schema has zero TDX/TEE/attestation fields. Once
 *   allow-listed, confidential SKUs will appear in GET /hardware
 *   with a distinct name (e.g. "H200 TDX") OR via a private
 *   node_pool_id (TBD until allow-list confirmed).
 *
 *   Until confidential is allow-listed, this adapter still works as
 *   a standard (non-confidential) overflow supplier alongside Lambda
 *   + RunPod — io.net's network is large and capacity windows are
 *   independent.
 *
 * Tenancy model:
 *   - Single-VM rentals via POST /deploy
 *   - Multi-VM clusters via replica_count (deferred — single-VM only
 *     in Phase 1)
 *   - Per-minute internal billing; 1-hour minimum, first hour
 *     non-refundable
 *
 * Key gotcha: POST /deploy returns an EMPTY response body. The
 * deployment_id must be discovered by polling GET /deployments and
 * filtering by resource_private_name immediately after.
 *
 * Auth: x-api-key header (NOT Bearer). Same key works at
 * cloud.io.net's UI flow.
 *
 * Confidential Inference is a SEPARATE product
 * (api.intelligence.io.net/v1) with its own attestation endpoints —
 * not handled by this adapter. If we ever want to surface
 * confidential inference, build a separate adapter on the inference
 * layer.
 */

// Verified per io.net docs (2026-06-03):
//   https://io.net/docs/reference/vmaas/get-started-with-vmaas-api.md
// Base URL is canonical production; no sandbox URL documented.
const DEFAULT_BASE_URL = 'https://api.io.solutions/enterprise/v1/io-cloud/vmaas'

export class IoNetApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `io.net API ${endpoint} returned ${statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
    this.name = 'IoNetApiError'
  }
}

/**
 * io.net hardware SKU (GPU instance type). One entry per
 * (gpuModel, vcpu, ram, storage) combination across supplier
 * networks. The deploy_id is what POST /deploy needs as hardware_id.
 */
export interface IoNetHardware {
  /** Composite internal id e.g. "8B300.240V__FI"; not used for deploy. */
  id: string
  /**
   * The id to pass as hardware_id when calling deploy.
   * io.net returns this as a STRING like "8B300.240V" (NOT numeric
   * as the public docs example suggested).
   */
  deployId: string
  /** Human-readable SKU name e.g. "H100 80GB SXM5". */
  name: string
  /** GPU count per VM at this SKU. */
  numCards: number
  /** "internal" (io.net-supplied) or "external" (partner network). */
  supplier: 'internal' | 'external'
  /** USD/hour. */
  pricePerHourUsd: number
  /** VRAM per card in GiB. */
  vramPerCardGb: number
  /** vCPU count per VM. */
  vcpu: number
  /** RAM in GiB. */
  memoryGb: number
  /**
   * Storage in GB. Docs say MB but real responses show values like
   * 3000 / 2500 — i.e. gigabytes (3TB / 2.5TB), consistent with the
   * size you'd expect on an 8-GPU enterprise box.
   */
  storageGb: number
  /** Free-form location string e.g. "FI", "US". */
  location: string
  /** Optional interconnect type e.g. "sxm6", "pcie5". */
  interconnect: string | null
  /** Whether NVLink is enabled. */
  nvlink: boolean
  /** Raw API row in case caller needs unknown fields. */
  raw: Record<string, unknown>
}

/**
 * io.net deployment lifecycle states. The literal strings come from
 * the docs' deployments filter values (note the spaces).
 */
export type IoNetDeploymentStatus =
  | 'deployment requested'
  | 'running'
  | 'completed'
  | 'failed'
  | 'termination requested'
  | 'destroyed'

export interface IoNetDeployment {
  id: string
  resourcePrivateName: string
  status: IoNetDeploymentStatus
  hardwareId: string
  hardwareName: string
  totalGpus: number
  gpusPerVm: number
  totalVms: number
  locations: Array<{ id: number; iso2: string; name: string }>
  amountPaidUsd: number | null
  completedPercent: number | null
  computeMinutesServed: number | null
  computeMinutesRemaining: number | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  raw: Record<string, unknown>
}

/**
 * Single VM/worker within a deployment. Multi-VM clusters return
 * multiple workers; single-VM rentals return one.
 */
export interface IoNetVm {
  deviceId: string
  vmId: string
  status: string
  hardware: string
  brandName: string
  uptimePercent: number | null
  gpusPerVm: number
  /** The actual SSH connect string io.net surfaces. */
  sshAccess: string | null
  publicIp: string | null
  publicPort: number | null
  vmEvents: Array<{ time: string; message: string }>
  createdAt: string | null
  raw: Record<string, unknown>
}

export interface DeployVmArgs {
  /** Cluster name; also our lookup key after POST returns empty body. */
  resourcePrivateName: string
  /** Hours to prepay; first hour non-refundable. Min 1, max 8760. */
  durationHours: number
  /** GPU count per VM. 1..8. */
  gpusPerVm: number
  /** Hardware deploy_id from GET /hardware (string like "8B300.240V"). */
  hardwareId: string
  /** SSH public key map. Key = name, value = openssh public key. */
  sshKeys: Record<string, string>
  /** Region location list, e.g. ["US"]. Mutually exclusive with node_pool_id. */
  locationIds?: string[]
  /**
   * Private node pool id (used when business@io.net allow-lists you
   * for confidential compute via private pool path). Mutually
   * exclusive with locationIds.
   */
  nodePoolId?: string
  /** "general" (Ubuntu+CUDA) or "datascience" (adds Python/Conda/RAPIDS). */
  vmImageType?: 'general' | 'datascience'
  /** Optional per-name port exposures. */
  networkServices?: Record<
    string,
    { port: number; protocol: 'tcp' | 'udp'; whitelist: string[] }
  >
}

export function isIoNetConfigured(): boolean {
  return Boolean(process.env.IONET_API_KEY?.trim())
}

export class IoNetClient {
  private readonly base: string
  private readonly apiKey: string

  constructor(apiKey?: string, baseUrl?: string) {
    const key = (apiKey ?? process.env.IONET_API_KEY ?? '').trim()
    if (!key) {
      throw new Error(
        'IoNetClient requires IONET_API_KEY env var or an explicit apiKey arg.',
      )
    }
    this.base = (baseUrl ?? process.env.IONET_API_BASE ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
    this.apiKey = key
  }

  /**
   * Catalog of hardware io.net offers. Mirrors RunPod listGpuTypes /
   * Phala listGpuTypes shape. Returns one entry per SKU across both
   * internal and external (partner) suppliers; caller can filter by
   * supplier if they want to prefer one over the other.
   */
  async listHardware(filters?: {
    gpu?: string
    regions?: string[]
    supplier?: 'internal' | 'external'
  }): Promise<IoNetHardware[]> {
    const qs = new URLSearchParams()
    if (filters?.gpu) qs.set('gpu', filters.gpu)
    if (filters?.supplier) qs.set('supplier', filters.supplier)
    if (filters?.regions) for (const r of filters.regions) qs.append('regions', r)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    // Real response shape verified 2026-06-03:
    //   { data: { hardware: [...] } }
    // The public docs example showed a flat array; the live API
    // wraps in a "data" envelope (probably for consistency with
    // io.net's other endpoints that paginate). Handle both shapes
    // for resilience against future repackaging.
    const raw = await this.request<RawHardwareEnvelope | RawHardwareItem[]>(
      `/hardware${suffix}`,
      'GET',
    )
    const items: RawHardwareItem[] = Array.isArray(raw)
      ? raw
      : (raw.data?.hardware ?? raw.hardware ?? [])
    return items.map(normalizeHardware)
  }

  /**
   * List deployments on the account. After POST /deploy (which
   * returns an empty body) call this filtered by name to discover
   * the new deployment_id. status param uses the literal strings
   * including spaces ("deployment requested" etc.).
   */
  async listDeployments(filters?: {
    status?: IoNetDeploymentStatus
    page?: number
    pageSize?: number
  }): Promise<IoNetDeployment[]> {
    const qs = new URLSearchParams()
    if (filters?.status) qs.set('status', filters.status)
    if (filters?.page !== undefined) qs.set('page', String(filters.page))
    if (filters?.pageSize !== undefined) qs.set('page_size', String(filters.pageSize))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const raw = await this.request<{ deployments?: RawDeploymentItem[] } | RawDeploymentItem[]>(
      `/deployments${suffix}`,
      'GET',
    )
    // Docs are vague about whether /deployments returns an array
    // directly or wraps it in {deployments:[]}. Handle both.
    const items = Array.isArray(raw) ? raw : (raw.deployments ?? [])
    return items.map(normalizeDeployment)
  }

  /** Fetch a single deployment by id. */
  async getDeployment(id: string): Promise<IoNetDeployment> {
    const raw = await this.request<RawDeploymentItem>(
      `/deployment/${encodeURIComponent(id)}`,
      'GET',
    )
    return normalizeDeployment(raw)
  }

  /**
   * Fetch the VMs/workers under a deployment. Single-VM rentals
   * return a workers[] of length 1; clusters return one entry per
   * worker. ssh_access + public_ip populate after the worker reaches
   * running status.
   */
  async getDeploymentVms(
    id: string,
    page = 1,
    pageSize = 20,
  ): Promise<IoNetVm[]> {
    const raw = await this.request<{ total: number; workers: RawVmItem[] }>(
      `/deployment/${encodeURIComponent(id)}/vms?page=${page}&page_size=${pageSize}`,
      'GET',
    )
    return (raw.workers ?? []).map(normalizeVm)
  }

  /**
   * Provision a VM. Returns the resource_private_name so the caller
   * can immediately call listDeployments({status: 'deployment requested'})
   * to discover the assigned deployment_id (io.net's POST /deploy
   * returns an empty body — the id is not in the response).
   */
  async deployVm(args: DeployVmArgs): Promise<string> {
    if (args.locationIds && args.nodePoolId) {
      throw new Error('deployVm: locationIds and nodePoolId are mutually exclusive')
    }
    const body: Record<string, unknown> = {
      resource_private_name: args.resourcePrivateName,
      duration_hours: args.durationHours,
      gpus_per_vm: args.gpusPerVm,
      hardware_id: args.hardwareId,
      ssh_keys: args.sshKeys,
      vm_image_type: args.vmImageType ?? 'general',
    }
    if (args.locationIds) body.location_ids = args.locationIds
    if (args.nodePoolId) body.node_pool_id = args.nodePoolId
    if (args.networkServices) body.network_services = args.networkServices

    await this.request<unknown>('/deploy', 'POST', body)
    return args.resourcePrivateName
  }

  /**
   * Helper: after deployVm, find the new deployment by its private
   * name. io.net doesn't return the id from POST /deploy, so this
   * is the canonical "did my deploy land?" check.
   */
  async findDeploymentByName(name: string): Promise<IoNetDeployment | null> {
    // Sweep recent deployments (status filter can lag). Order by
    // newest first; small pageSize since we expect to find it near
    // the top right after deploy.
    const recent = await this.listDeployments({ pageSize: 20 })
    return recent.find((d) => d.resourcePrivateName === name) ?? null
  }

  /**
   * Extend a rental by N more hours. The first-hour-nonrefundable
   * rule does NOT apply to extensions (the original first hour is
   * the only non-refundable one).
   */
  async extendDeployment(id: string, additionalHours: number): Promise<IoNetDeployment> {
    const raw = await this.request<RawDeploymentItem>(
      `/deployment/${encodeURIComponent(id)}/extend`,
      'POST',
      { duration_hours: additionalHours },
    )
    return normalizeDeployment(raw)
  }

  /**
   * Terminate a deployment. Stops billing (beyond the
   * first-hour-nonrefundable charge). Returns nothing on success;
   * 404 on already-deleted is treated as a no-op so callers can
   * safely retry.
   */
  async terminateDeployment(id: string): Promise<void> {
    try {
      await this.request<unknown>(
        `/deployment/${encodeURIComponent(id)}`,
        'DELETE',
      )
    } catch (err) {
      if (err instanceof IoNetApiError && err.statusCode === 404) return
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
        // io.net VMaaS uses lowercase x-api-key (case-insensitive in
        // HTTP). NOT Authorization: Bearer — that's for the separate
        // confidential-inference product at api.intelligence.io.net.
        'x-api-key': this.apiKey,
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
      throw new IoNetApiError(res.status, path, parsed ?? text)
    }
    return parsed as T
  }
}

// ---------------------------------------------------------------------------
// Raw response shapes + normalizers
// ---------------------------------------------------------------------------

interface RawHardwareEnvelope {
  data?: { hardware?: RawHardwareItem[] }
  hardware?: RawHardwareItem[]
}

interface RawHardwareItem {
  id: string
  deploy_id: string
  name: string
  num_cards: number
  supplier: 'internal' | 'external'
  price: number
  vram_per_card: number
  vcpu: number
  memory: number
  storage: number
  location: string
  interconnect?: string | null
  nvlink?: boolean
  [extra: string]: unknown
}

function normalizeHardware(raw: RawHardwareItem): IoNetHardware {
  return {
    id: raw.id,
    deployId: raw.deploy_id,
    name: raw.name,
    numCards: raw.num_cards,
    supplier: raw.supplier,
    pricePerHourUsd: raw.price,
    vramPerCardGb: raw.vram_per_card,
    vcpu: raw.vcpu,
    memoryGb: raw.memory,
    storageGb: raw.storage,
    location: raw.location,
    interconnect: raw.interconnect ?? null,
    nvlink: raw.nvlink ?? false,
    raw,
  }
}

interface RawDeploymentItem {
  id: string
  resource_private_name?: string
  status?: IoNetDeploymentStatus
  hardware_id?: string
  hardware_name?: string
  total_gpus?: number
  gpus_per_vm?: number
  total_vms?: number
  locations?: Array<{ id: number; iso2: string; name: string }>
  amount_paid?: number
  completed_percent?: number
  compute_minutes_served?: number
  compute_minutes_remaining?: number
  created_at?: string
  started_at?: string
  finished_at?: string
  [extra: string]: unknown
}

function normalizeDeployment(raw: RawDeploymentItem): IoNetDeployment {
  return {
    id: raw.id,
    resourcePrivateName: raw.resource_private_name ?? '',
    status: raw.status ?? 'deployment requested',
    hardwareId: raw.hardware_id ?? '',
    hardwareName: raw.hardware_name ?? 'unknown',
    totalGpus: raw.total_gpus ?? 0,
    gpusPerVm: raw.gpus_per_vm ?? 1,
    totalVms: raw.total_vms ?? 1,
    locations: raw.locations ?? [],
    amountPaidUsd: typeof raw.amount_paid === 'number' ? raw.amount_paid : null,
    completedPercent: typeof raw.completed_percent === 'number' ? raw.completed_percent : null,
    computeMinutesServed: typeof raw.compute_minutes_served === 'number' ? raw.compute_minutes_served : null,
    computeMinutesRemaining:
      typeof raw.compute_minutes_remaining === 'number' ? raw.compute_minutes_remaining : null,
    createdAt: raw.created_at ?? null,
    startedAt: raw.started_at ?? null,
    finishedAt: raw.finished_at ?? null,
    raw,
  }
}

interface RawVmItem {
  device_id: string
  vm_id: string
  status: string
  hardware: string
  brand_name: string
  uptime_percent?: number
  gpus_per_vm?: number
  ssh_access?: string
  public_ip?: string
  public_port?: number
  vm_events?: Array<{ time: string; message: string }>
  created_at?: string
  [extra: string]: unknown
}

function normalizeVm(raw: RawVmItem): IoNetVm {
  return {
    deviceId: raw.device_id,
    vmId: raw.vm_id,
    status: raw.status,
    hardware: raw.hardware,
    brandName: raw.brand_name,
    uptimePercent: typeof raw.uptime_percent === 'number' ? raw.uptime_percent : null,
    gpusPerVm: raw.gpus_per_vm ?? 1,
    sshAccess: raw.ssh_access ?? null,
    publicIp: raw.public_ip ?? null,
    publicPort: typeof raw.public_port === 'number' ? raw.public_port : null,
    vmEvents: raw.vm_events ?? [],
    createdAt: raw.created_at ?? null,
    raw,
  }
}
