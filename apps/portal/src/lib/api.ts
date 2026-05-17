const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('a2e_access_token')
}

function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('a2e_refresh_token')
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem('a2e_access_token', accessToken)
  localStorage.setItem('a2e_refresh_token', refreshToken)
}

export function clearTokens() {
  localStorage.removeItem('a2e_access_token')
  localStorage.removeItem('a2e_refresh_token')
}

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false

  try {
    const res = await fetch(`${API_URL}/v1/portal/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })

    if (!res.ok) return false

    const data = await res.json()
    setTokens(data.accessToken, data.refreshToken)
    return true
  } catch {
    return false
  }
}

export async function apiFetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options

  const token = getToken()
  const fetchHeaders: Record<string, string> = {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  }
  if (token) {
    fetchHeaders['Authorization'] = `Bearer ${token}`
  }

  let res = await fetch(`${API_URL}${path}`, {
    method,
    headers: fetchHeaders,
    body: body ? JSON.stringify(body) : undefined,
  })

  // If 401, try token refresh
  if (res.status === 401 && token) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      fetchHeaders['Authorization'] = `Bearer ${getToken()}`
      res = await fetch(`${API_URL}${path}`, {
        method,
        headers: fetchHeaders,
        body: body ? JSON.stringify(body) : undefined,
      })
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.message || error.error || `HTTP ${res.status}`)
  }

  return res.json()
}

// Auth API
export const auth = {
  register: (
    email: string,
    password: string,
    role?: 'NODE_RUNNER' | 'COMPUTE_BUYER',
    referralCode?: string,
  ) =>
    apiFetch<{
      user: { id: string; email: string; role: string }
      accessToken: string
      refreshToken: string
      referral?: { status: string }
    }>(
      '/v1/portal/auth/register',
      {
        method: 'POST',
        body: {
          email,
          password,
          ...(role ? { role } : {}),
          ...(referralCode ? { referralCode } : {}),
        },
      },
    ),
  login: (email: string, password: string) =>
    apiFetch<{ user: { id: string; email: string | null; walletAddress: string | null; role: string; nodeRunnerId: string | null }; accessToken: string; refreshToken: string }>(
      '/v1/portal/auth/login', { method: 'POST', body: { email, password } }
    ),
  walletNonce: (address: string) =>
    apiFetch<{ nonce: string; message: string }>(`/v1/portal/auth/wallet/nonce?address=${address}`),
  walletAuth: (
    address: string,
    signature: string,
    nonce: string,
    role?: 'NODE_RUNNER' | 'COMPUTE_BUYER'
  ) =>
    apiFetch<{ user: { id: string; walletAddress: string | null; role: string; nodeRunnerId: string | null }; accessToken: string; refreshToken: string }>(
      '/v1/portal/auth/wallet', {
        method: 'POST',
        body: { address, signature, nonce, ...(role ? { role } : {}) },
      }
    ),
  me: () => apiFetch<{ id: string; email: string | null; walletAddress: string | null; role: string; nodeRunnerId: string | null; createdAt: string }>(
    '/v1/portal/auth/me'
  ),
  logout: (refreshToken: string) =>
    apiFetch('/v1/portal/auth/logout', { method: 'POST', body: { refreshToken } }),
}

// Node Runner API
export const nodeRunner = {
  profile: () => apiFetch('/v1/portal/node-runner/profile'),
  dashboard: () => apiFetch('/v1/portal/node-runner/dashboard'),
  operatorStats: () => apiFetch('/v1/portal/node-runner/operator-stats'),
  nodes: () => apiFetch<{ nodes: unknown[] }>('/v1/portal/node-runner/nodes'),
  node: (id: string) => apiFetch(`/v1/portal/node-runner/nodes/${id}`),
  updateNode: (id: string, data: unknown) => apiFetch(`/v1/portal/node-runner/nodes/${id}`, { method: 'PATCH', body: data }),
  deleteNode: (id: string) => apiFetch(`/v1/portal/node-runner/nodes/${id}`, { method: 'DELETE' }),
  pauseAll: () => apiFetch<{ success: boolean; count: number; message: string }>('/v1/portal/node-runner/nodes/pause-all', { method: 'POST' }),
  resumeAll: () => apiFetch<{ success: boolean; count: number; message: string }>('/v1/portal/node-runner/nodes/resume-all', { method: 'POST' }),
  earnings: (period?: string) => apiFetch(`/v1/portal/node-runner/earnings${period ? `?period=${period}` : ''}`),
  earningsHistory: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/portal/node-runner/earnings/history${qs}`)
  },
  payouts: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/portal/node-runner/payouts${qs}`)
  },
  // Payout-mode feature: read the current AUTO/MANUAL/SCHEDULED mode
  // plus the live platform balance (computed from earnings - paid
  // settlements at read time, so never drifts), and the "Withdraw
  // now" trigger that bypasses any hold mode.
  payoutMode: () =>
    apiFetch<{
      mode: 'AUTO' | 'MANUAL' | 'SCHEDULED'
      scheduledAt: string | null
      available: number
      pending: number
      nextUnlockAt: string | null
      cooldownHours: number
      spent: number
      /** @deprecated alias of `available`, kept for compatibility */
      platformBalance: number
    }>('/v1/portal/node-runner/payouts/mode'),
  // Internal-spend ledger for the operator: rentals the operator
  // paid for with their own platform balance (only populated when
  // the user has the dual buyer + operator role).
  internalSpends: () =>
    apiFetch<{
      spends: Array<{
        id: string
        computeRequestId: string
        amount: number
        createdAt: string
        updatedAt: string
        rental: {
          id: string
          gpuTier: string
          gpuCount: number
          durationDays: number
          status: string
          totalCost: number
          requestedAt: string
          completedAt: string | null
        } | null
      }>
      total: number
    }>('/v1/portal/node-runner/internal-spends'),
  withdrawNow: (body?: { walletAddress?: string; saveWallet?: boolean }) =>
    apiFetch<{
      totalPaid: number
      modeResetToAuto: boolean
      destinationWallet: string
      settlements: Array<{
        settlementId: string
        success: boolean
        txHash?: string
        error?: string
        amount: number
      }>
    }>('/v1/portal/node-runner/payouts/withdraw-now', { method: 'POST', body: body ?? {} }),
  settings: (data: unknown) => apiFetch('/v1/portal/node-runner/settings', { method: 'PATCH', body: data }),
  jobs: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/portal/node-runner/jobs${qs}`)
  },
  job: (id: string) => apiFetch(`/v1/portal/node-runner/jobs/${id}`),
  withdrawals: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/portal/node-runner/withdrawals${qs}`)
  },
  withdrawalBalance: () => apiFetch('/v1/portal/node-runner/withdrawals/balance'),
  requestWithdrawal: (data: { amount: number; walletAddress: string }) =>
    apiFetch('/v1/portal/node-runner/withdrawals/request', { method: 'POST', body: data }),
  withdrawal: (id: string) => apiFetch(`/v1/portal/node-runner/withdrawals/${id}`),
  investments: () => apiFetch('/v1/portal/node-runner/investments'),
  deploy: (data: { gpuTier: string; nodeCount: number; txHash: string; cryptoAmount?: number; cryptoCurrency?: string; deploymentNote?: string }) =>
    apiFetch('/v1/portal/node-runner/deploy', { method: 'POST', body: data }),
  deployments: () => apiFetch('/v1/portal/node-runner/deployments'),
  deployment: (id: string) => apiFetch(`/v1/portal/node-runner/deployments/${id}`),
  referral: () => apiFetch('/v1/portal/referral'),
}

// BYOG install-token API (launch-blocker #1). Mints a one-shot token
// and returns the curl|bash command the operator copies into a terminal
// on their GPU machine.
export const byog = {
  issueToken: (region?: string) =>
    apiFetch<{ token: string; installCommand: string; expiresAt: string }>(
      '/v1/byog/issue-token',
      { method: 'POST', body: region ? { region } : {} }
    ),
}

// Buyer API
export const buyer = {
  dashboard: () => apiFetch('/v1/buyer/dashboard'),
  // Internal-spend eligibility + balance check. Returns eligible=false
  // when the user has no NodeRunner profile (pure buyer); returns the
  // live available balance when they do. UI uses this to decide
  // whether to render the "Pay from operator balance" radio.
  internalBalance: () =>
    apiFetch<{
      eligible: boolean
      available: number
      spent?: number
      pending?: number
    }>('/v1/buyer/compute/internal-balance'),
  requestCompute: (data: {
    gpuTier: string
    gpuCount: number
    durationDays: number
    purpose?: string
    // USDC payments require a txHash. INTERNAL_BALANCE rentals omit it
    // (server generates INTERNAL:<id>).
    txHash?: string
    // Payment source. USDC default, INTERNAL_BALANCE for dual-role
    // users paying from their accumulated operator balance.
    paymentSource?: 'USDC' | 'INTERNAL_BALANCE'
    // M3: pricing tier + optional commitment (RESERVED only)
    tier?: 'ON_DEMAND' | 'SPOT' | 'RESERVED'
    commitmentDays?: number
    // M4.4: optional region hard-filter (free-form, e.g. us-east-1).
    // null/undefined/empty means "Any" - allocator skips the filter.
    requiredRegion?: string | null
    // M5.10c: optional operator preference (slug). Soft preference -
    // allocator falls back to general pool if this operator has no
    // idle capacity. Null/undefined means no preference.
    preferredOperatorSlug?: string | null
    // M6 / launch-blocker #2 dependency: buyer's SSH public key. The
    // agent installs this into the rental user's authorized_keys at
    // provision time. Required for real (non-test-mode) rentals.
    sshPubKey?: string
  }) =>
    apiFetch('/v1/buyer/compute/request', { method: 'POST', body: data }),
  requests: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/buyer/compute/requests${qs}`)
  },
  request: (id: string) => apiFetch(`/v1/buyer/compute/requests/${id}`),
  activeCompute: () => apiFetch('/v1/buyer/compute/active'),
  cancelRequest: (id: string) => apiFetch(`/v1/buyer/compute/requests/${id}/cancel`, { method: 'PATCH' }),
  terminateRequest: (id: string) => apiFetch(`/v1/buyer/compute/requests/${id}/terminate`, { method: 'POST' }),
  rate: (id: string, data: { score: number; comment?: string }) =>
    apiFetch(`/v1/buyer/compute/requests/${id}/rate`, { method: 'POST', body: data }),
  // M3: trigger a workspace checkpoint mid-rental
  checkpoint: (id: string) =>
    apiFetch<{ id: string; checkpointStatus: string; message: string }>(
      `/v1/buyer/compute/requests/${id}/checkpoint`,
      { method: 'POST' },
    ),
  getRating: (id: string) =>
    apiFetch<{ rating: { id: string; score: number; comment: string | null; moderationStatus: string; createdAt: string } | null }>(
      `/v1/buyer/compute/requests/${id}/rating`,
    ),
  settings: (data: unknown) => apiFetch('/v1/buyer/settings', { method: 'PATCH', body: data }),
  billing: () => apiFetch('/v1/buyer/billing'),
  invoiceUrl: (requestId: string) => `${API_URL}/v1/buyer/billing/invoice/${requestId}`,
}

// Notifications API
export const notifications = {
  list: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/portal/notifications${qs}`)
  },
  unreadCount: () => apiFetch<{ count: number }>('/v1/portal/notifications/unread-count'),
  markRead: (id: string) => apiFetch(`/v1/portal/notifications/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => apiFetch('/v1/portal/notifications/read-all', { method: 'PATCH' }),
  delete: (id: string) => apiFetch(`/v1/portal/notifications/${id}`, { method: 'DELETE' }),
}
