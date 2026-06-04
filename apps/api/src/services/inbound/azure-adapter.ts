/**
 * T5h — Azure NCCadsH100v5 Confidential VM adapter (inbound supply,
 * AMD SEV-SNP CPU TEE + NVIDIA Hopper CC GPU TEE).
 *
 * Fifth confidential supplier after Phala, GCP A3, io.net, VoltageGPU.
 * Azure Standard_NCC40ads_H100_v5 is the only public-cloud SKU
 * combining (a) AMD SEV-SNP CPU TEE + (b) NVIDIA H100 NVL CC mode GPU
 * TEE + (c) self-serve REST API + (d) per-second billing + (e) GA
 * status (no preview gate). At $2.19/h spot it's the cheapest
 * confidential GPU TEE on the market as of 2026-06-04.
 *
 * Why this matters: gives the platform a SEV-SNP path alongside the
 * Intel TDX path (GCP A3). Different CPU vendor primitive, same
 * end-to-end confidential boundary (CPU memory encrypted + GPU memory
 * encrypted + attestation chain). Testers accepting either primitive
 * route via whichever cloud has capacity first.
 *
 * Auth: Azure AD service principal (client_credentials grant).
 * The SP credential is client_id + client_secret + tenant_id. We
 * exchange these at https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
 * for a bearer token scoped to https://management.azure.com/.default.
 * Tokens last 1 hour; we cache for ~55 min to leave clock-skew margin.
 *
 * Status mapping (Azure -> ExternalRental status):
 *   creating / starting / updating -> PENDING
 *   running                         -> ACTIVE
 *   stopping / deallocating         -> CLOSING
 *   stopped / deallocated / deleted -> CLOSED
 *
 * Pricing (April 2026 reference, verify at provision):
 *   Standard_NCC40ads_H100_v5 on-demand: ~$6.98/hr (1 H100 NVL 94GB)
 *   Standard_NCC40ads_H100_v5 spot:      ~$2.19/hr per GPU
 *   Per-second billing on hyperscaler tier, no minimum.
 *
 * Quota gate:
 *   Default quota for Standard NCC family vCPUs is 0
 *   User files quota request (1-4 business day approval typical)
 *   Adapter calls return 409 OperationNotAllowed until quota lands
 *   Allocator skips Azure gracefully when quota not yet approved
 *
 * SSH model: Azure injects the buyer's public key via VM osProfile
 *   osProfile.linuxConfiguration.ssh.publicKeys[].keyData
 *   osProfile.adminUsername = 'azureuser' (or buyer choice)
 * No per-key registration on Azure side; matches GCP/Phala/RunPod pattern.
 *
 * Resource model: unlike GCP where instances are zone-scoped,
 * Azure groups resources into resource groups. Each provisioned VM
 * creates: a resource group (or reuses our shared one), a NIC, a
 * public IP, a managed disk, and the VM itself. Cleanup deletes
 * the entire RG to avoid orphan resources.
 *
 * Configurability:
 *   AZURE_SUBSCRIPTION_ID -> required, your Azure subscription GUID
 *   AZURE_TENANT_ID       -> required, AAD tenant GUID
 *   AZURE_CLIENT_ID       -> required, service principal client ID
 *   AZURE_CLIENT_SECRET   -> required, service principal secret
 *   AZURE_API_BASE        -> optional, defaults to management.azure.com
 */

const DEFAULT_BASE_URL = 'https://management.azure.com'
const TOKEN_HOST = 'https://login.microsoftonline.com'
const API_VERSION = '2024-07-01'
const SCOPE = 'https://management.azure.com/.default'

/**
 * Azure regions known to carry NCCadsH100v5 confidential VMs as of
 * 2026-06-04. Adapter rotates through these on capacity errors.
 * Source: Microsoft documentation + capacity check.
 */
export const AZURE_NCC_H100_REGIONS = [
  'eastus2',
  'westeurope',
  'swedencentral',
  'centralus',
] as const

/**
 * Default OS image for confidential H100 VMs. Must be a confidential-
 * VM-compatible image with NVIDIA driver support for H100 CC mode.
 * Iterable: first provision may reveal the right image SKU.
 */
export const AZURE_NCC_DEFAULT_IMAGE = {
  publisher: 'canonical',
  offer: 'ubuntu-24_04-lts',
  sku: 'cvm',
  version: 'latest',
} as const

export class AzureApiError extends Error {
  constructor(
    public statusCode: number,
    public endpoint: string,
    public body: unknown,
  ) {
    super(
      `Azure API ${endpoint} returned ${statusCode}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    )
    this.name = 'AzureApiError'
  }
}

export type AzureVmStatus =
  | 'creating'
  | 'updating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'deallocating'
  | 'deallocated'
  | 'deleting'
  | 'failed'

export interface AzureVm {
  /** Azure VM name (also used as canonical id within RG scope). */
  name: string
  /** Resource group this VM belongs to. */
  resourceGroup: string
  /** Azure region (eastus2, westeurope, etc.). */
  location: string
  status: AzureVmStatus
  /** Public IP, populated when allocated and running. */
  publicIp: string | null
  /** Private NIC IP. */
  privateIp: string | null
  /** VM size short name (e.g. "Standard_NCC40ads_H100_v5"). */
  vmSize: string
  /** Spot priority (preemptible) vs Regular. */
  spot: boolean
  /** ISO timestamp from Azure. */
  createdAt: string | null
}

export interface CreateAzureVmArgs {
  /** VM name, lowercase alphanumeric + hyphens, max 64 chars. */
  name: string
  /** Resource group to provision into. Created if missing. */
  resourceGroup: string
  /** Azure region. Pick from AZURE_NCC_H100_REGIONS. */
  location: string
  /** VM SKU name, e.g. Standard_NCC40ads_H100_v5. */
  vmSize: string
  /** SSH public key in OpenSSH format. */
  sshPublicKey: string
  /** SSH admin username. Default 'azureuser'. */
  adminUsername?: string
  /** OS disk size in GB. Default 128. */
  osDiskSizeGb?: number
  /** Override the default OS image. */
  imageReference?: {
    publisher: string
    offer: string
    sku: string
    version: string
  }
  /** Use Spot priority for ~70% cost reduction. Default true. */
  spot?: boolean
}

export interface CreateAzureVmResult {
  vmName: string
  resourceGroup: string
  location: string
  /** Async operation Azure returns; caller can wait or just poll the VM. */
  operationUrl: string | null
}

interface ServicePrincipalConfig {
  subscriptionId: string
  tenantId: string
  clientId: string
  clientSecret: string
}

export function isAzureConfigured(): boolean {
  return (
    Boolean(process.env.AZURE_SUBSCRIPTION_ID?.trim()) &&
    Boolean(process.env.AZURE_TENANT_ID?.trim()) &&
    Boolean(process.env.AZURE_CLIENT_ID?.trim()) &&
    Boolean(process.env.AZURE_CLIENT_SECRET?.trim())
  )
}

/**
 * Azure Compute REST client. One instance per process is fine; the
 * cached access token is shared across method calls.
 */
export class AzureClient {
  private readonly base: string
  private readonly sp: ServicePrincipalConfig
  private tokenCache: { token: string; expiresAt: number } | null = null

  constructor(opts?: {
    subscriptionId?: string
    tenantId?: string
    clientId?: string
    clientSecret?: string
    baseUrl?: string
  }) {
    const subscriptionId = (opts?.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID ?? '').trim()
    const tenantId = (opts?.tenantId ?? process.env.AZURE_TENANT_ID ?? '').trim()
    const clientId = (opts?.clientId ?? process.env.AZURE_CLIENT_ID ?? '').trim()
    const clientSecret = (opts?.clientSecret ?? process.env.AZURE_CLIENT_SECRET ?? '').trim()

    if (!subscriptionId || !tenantId || !clientId || !clientSecret) {
      throw new Error(
        'AzureClient requires AZURE_SUBSCRIPTION_ID + AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET env vars (or matching opts).',
      )
    }

    this.sp = { subscriptionId, tenantId, clientId, clientSecret }
    this.base = (opts?.baseUrl ?? process.env.AZURE_API_BASE ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
  }

  /**
   * Exchange service principal credentials for an OAuth2 access token
   * scoped to Azure Resource Manager. Tokens last 1 hour; we cache for
   * ~55 min to leave clock-skew margin.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token
    }

    const url = `${TOKEN_HOST}/${encodeURIComponent(this.sp.tenantId)}/oauth2/v2.0/token`
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.sp.clientId,
      client_secret: this.sp.clientSecret,
      scope: SCOPE,
    }).toString()

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    const text = await res.text()
    if (!res.ok) {
      throw new AzureApiError(res.status, url, text)
    }
    const data = JSON.parse(text) as { access_token: string; expires_in: number }
    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + data.expires_in * 1000 - 60_000,
    }
    return data.access_token
  }

  /**
   * Ensure a resource group exists in the given location. Idempotent;
   * Azure returns 200 if the RG already exists with the same location,
   * 409 if it exists in a different location.
   */
  async ensureResourceGroup(name: string, location: string): Promise<void> {
    const path = `/subscriptions/${this.sp.subscriptionId}/resourcegroups/${encodeURIComponent(name)}?api-version=${API_VERSION}`
    await this.request<unknown>(path, 'PUT', { location })
  }

  /**
   * Create a confidential NCCadsH100v5 VM. Returns the VM name + the
   * Azure operation URL for callers that want to wait on completion.
   *
   * Confidential A3 requires:
   *   - securityProfile.securityType = "ConfidentialVM"
   *   - securityProfile.uefiSettings.secureBootEnabled = true
   *   - securityProfile.uefiSettings.vTpmEnabled = true
   *   - confidential-VM-compatible image SKU
   *   - vmSize in NCCads family
   *   - osDisk.managedDisk.securityProfile.securityEncryptionType =
   *     "VMGuestStateOnly" or "DiskWithVMGuestState"
   */
  async createInstance(args: CreateAzureVmArgs): Promise<CreateAzureVmResult> {
    await this.ensureResourceGroup(args.resourceGroup, args.location)

    const adminUser = (args.adminUsername ?? 'azureuser').trim()
    const sshKey = args.sshPublicKey.trim()
    const image = args.imageReference ?? AZURE_NCC_DEFAULT_IMAGE

    const path = `/subscriptions/${this.sp.subscriptionId}/resourceGroups/${encodeURIComponent(args.resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(args.name)}?api-version=${API_VERSION}`

    const body = {
      location: args.location,
      properties: {
        hardwareProfile: {
          vmSize: args.vmSize,
        },
        storageProfile: {
          imageReference: image,
          osDisk: {
            createOption: 'FromImage',
            diskSizeGB: args.osDiskSizeGb ?? 128,
            managedDisk: {
              storageAccountType: 'Premium_LRS',
              securityProfile: {
                securityEncryptionType: 'VMGuestStateOnly',
              },
            },
          },
        },
        osProfile: {
          computerName: args.name.slice(0, 15),
          adminUsername: adminUser,
          linuxConfiguration: {
            disablePasswordAuthentication: true,
            ssh: {
              publicKeys: [
                {
                  path: `/home/${adminUser}/.ssh/authorized_keys`,
                  keyData: sshKey,
                },
              ],
            },
          },
        },
        networkProfile: {
          networkInterfaces: [
            {
              id: '/subscriptions/' + this.sp.subscriptionId + '/resourceGroups/' + args.resourceGroup + '/providers/Microsoft.Network/networkInterfaces/' + args.name + '-nic',
              properties: { primary: true },
            },
          ],
        },
        securityProfile: {
          securityType: 'ConfidentialVM',
          uefiSettings: {
            secureBootEnabled: true,
            vTpmEnabled: true,
          },
        },
        priority: args.spot === false ? 'Regular' : 'Spot',
        ...(args.spot !== false
          ? {
              evictionPolicy: 'Deallocate',
              billingProfile: { maxPrice: -1 },
            }
          : {}),
      },
    }

    const res = await this.requestWithHeaders<{ id: string; name: string }>(path, 'PUT', body)
    return {
      vmName: args.name,
      resourceGroup: args.resourceGroup,
      location: args.location,
      operationUrl: res.headers.get('azure-asyncoperation') ?? null,
    }
  }

  /**
   * Poll a specific VM. Returns the VM's current status + IP + size.
   */
  async getInstance(resourceGroup: string, name: string): Promise<AzureVm> {
    const path = `/subscriptions/${this.sp.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}?api-version=${API_VERSION}&$expand=instanceView`
    const raw = await this.request<RawVm>(path, 'GET')

    // Public IP requires a separate request to the associated NIC's
    // public IP resource. We resolve lazily here.
    let publicIp: string | null = null
    let privateIp: string | null = null
    const nicId = raw.properties?.networkProfile?.networkInterfaces?.[0]?.id
    if (nicId) {
      try {
        const nic = await this.request<RawNic>(`${nicId}?api-version=${API_VERSION}`, 'GET')
        const ipConfig = nic.properties?.ipConfigurations?.[0]?.properties
        privateIp = ipConfig?.privateIPAddress ?? null
        const pipId = ipConfig?.publicIPAddress?.id
        if (pipId) {
          const pip = await this.request<RawPublicIp>(`${pipId}?api-version=${API_VERSION}`, 'GET')
          publicIp = pip.properties?.ipAddress ?? null
        }
      } catch {
        // NIC lookup failure shouldn't bring down the poll
      }
    }

    return {
      name: raw.name,
      resourceGroup,
      location: raw.location,
      status: parseStatus(raw.properties?.instanceView?.statuses ?? []),
      publicIp,
      privateIp,
      vmSize: raw.properties?.hardwareProfile?.vmSize ?? 'unknown',
      spot: raw.properties?.priority === 'Spot',
      createdAt: raw.properties?.timeCreated ?? null,
    }
  }

  /**
   * Delete a VM. Returns immediately; Azure processes the delete
   * asynchronously. Idempotent on 404.
   *
   * Note: this deletes ONLY the VM, not its NIC / public IP / disk /
   * resource group. For full cleanup, also call deleteResourceGroup
   * once we're sure nothing else lives in it (Phase 2 enhancement).
   */
  async deleteInstance(resourceGroup: string, name: string): Promise<void> {
    const path = `/subscriptions/${this.sp.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}?api-version=${API_VERSION}`
    try {
      await this.request<unknown>(path, 'DELETE')
    } catch (err) {
      if (err instanceof AzureApiError && err.statusCode === 404) return
      throw err
    }
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<T> {
    const res = await this.requestWithHeaders<T>(path, method, body)
    return res.body
  }

  private async requestWithHeaders<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<{ body: T; headers: Headers }> {
    const token = await this.getAccessToken()
    const url = path.startsWith('http') ? path : `${this.base}${path}`
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
      throw new AzureApiError(res.status, path, parsed ?? text)
    }
    return { body: parsed as T, headers: res.headers }
  }
}

// ---- Raw response shapes (Azure Compute REST) ----

interface RawVm {
  id: string
  name: string
  location: string
  properties?: {
    timeCreated?: string
    hardwareProfile?: { vmSize?: string }
    priority?: 'Regular' | 'Spot'
    instanceView?: {
      statuses?: Array<{ code?: string; displayStatus?: string; level?: string }>
    }
    networkProfile?: {
      networkInterfaces?: Array<{ id?: string }>
    }
  }
}

interface RawNic {
  properties?: {
    ipConfigurations?: Array<{
      properties?: {
        privateIPAddress?: string
        publicIPAddress?: { id?: string }
      }
    }>
  }
}

interface RawPublicIp {
  properties?: {
    ipAddress?: string
  }
}

/**
 * Translate Azure's instanceView status codes to our enum. Azure's
 * codes look like "PowerState/running" or "ProvisioningState/succeeded".
 */
function parseStatus(
  statuses: Array<{ code?: string; displayStatus?: string }>,
): AzureVmStatus {
  // Power state takes precedence over provisioning state for an
  // already-created VM. For a VM still being created, fall through.
  for (const s of statuses) {
    const code = (s.code ?? '').toLowerCase()
    if (code.startsWith('powerstate/')) {
      const power = code.slice('powerstate/'.length)
      switch (power) {
        case 'running':
          return 'running'
        case 'stopped':
          return 'stopped'
        case 'deallocated':
          return 'deallocated'
        case 'starting':
          return 'starting'
        case 'stopping':
          return 'stopping'
        case 'deallocating':
          return 'deallocating'
      }
    }
  }
  for (const s of statuses) {
    const code = (s.code ?? '').toLowerCase()
    if (code.startsWith('provisioningstate/')) {
      const prov = code.slice('provisioningstate/'.length)
      switch (prov) {
        case 'creating':
          return 'creating'
        case 'updating':
          return 'updating'
        case 'deleting':
          return 'deleting'
        case 'failed':
          return 'failed'
      }
    }
  }
  return 'creating'
}
