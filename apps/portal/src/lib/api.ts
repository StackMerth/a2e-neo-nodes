import { putCache, getCache, clearCache as clearOfflineCache } from './offlineCache'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

// Fired from apiFetch when a GET request was served from IndexedDB
// rather than the live network. OfflineBanner listens for this and
// shows a "Showing cached data" message.
function emitCacheFallback(cachedAt: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('a2e:cache-fallback', { detail: { cachedAt } }))
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
  // Wipe the offline cache too so the next account that signs in on
  // this device never sees the previous account's leftover data.
  void clearOfflineCache()
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
  const isGet = method.toUpperCase() === 'GET'

  // Offline-first short-circuit: if the browser knows it's offline,
  // skip the network call entirely and try the cache. Snappier UX +
  // saves a guaranteed-to-fail fetch + lets the user keep navigating.
  if (isGet && typeof navigator !== 'undefined' && navigator.onLine === false) {
    const cached = await getCache<T>(path)
    if (cached) {
      emitCacheFallback(cached.cachedAt)
      return cached.data
    }
    // No cache either — let the fetch run and produce a real network
    // error so the caller's catch surface stays consistent.
  }

  const token = getToken()
  const fetchHeaders: Record<string, string> = {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  }
  if (token) {
    fetchHeaders['Authorization'] = `Bearer ${token}`
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (netErr) {
    // Pure network failure (DNS, offline, CORS, server down). For GETs,
    // fall back to the cache so the UI keeps rendering. For mutations
    // we still throw — those need to retry against a live server.
    if (isGet) {
      const cached = await getCache<T>(path)
      if (cached) {
        emitCacheFallback(cached.cachedAt)
        return cached.data
      }
    }
    throw netErr
  }

  // If 401, try token refresh
  if (res.status === 401 && token) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      fetchHeaders['Authorization'] = `Bearer ${getToken()}`
      try {
        res = await fetch(`${API_URL}${path}`, {
          method,
          headers: fetchHeaders,
          body: body ? JSON.stringify(body) : undefined,
        })
      } catch (netErr) {
        if (isGet) {
          const cached = await getCache<T>(path)
          if (cached) {
            emitCacheFallback(cached.cachedAt)
            return cached.data
          }
        }
        throw netErr
      }
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.message || error.error || `HTTP ${res.status}`)
  }

  const data = (await res.json()) as T
  // Cache successful GETs in the background. Best-effort; never blocks
  // the live response.
  if (isGet) {
    void putCache(path, data)
  }
  return data
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
  me: () => apiFetch<{ id: string; email: string | null; walletAddress: string | null; role: string; nodeRunnerId: string | null; createdAt: string; emailVerified?: boolean }>(
    '/v1/portal/auth/me'
  ),
  logout: (refreshToken: string) =>
    apiFetch('/v1/portal/auth/logout', { method: 'POST', body: { refreshToken } }),
  // Re-fires the verification email for the currently signed-in user.
  // Backend auto-sends one at signup; this is the manual resend the
  // dashboard banner offers when the original email got lost.
  sendVerification: () =>
    apiFetch<{ success: boolean; message: string }>(
      '/v1/portal/auth/send-verification',
      { method: 'POST', body: {} },
    ),

  // Phase B sign-to-link flow: caller fetches a challenge, the wallet
  // signs the message, caller posts the signed blob back to /verify.
  // Result is the wallet linked to the User row, gated on a real
  // signature check (vs the unsigned PATCH /v1/portal/user/wallet
  // endpoint we keep around for manual-paste / hardware-wallet flows).
  linkWalletChallenge: (address: string) =>
    apiFetch<{ nonce: string; message: string }>(
      `/v1/portal/user/link-wallet/challenge?address=${encodeURIComponent(address)}`,
    ),
  linkWalletVerify: (data: { walletAddress: string; signature: string; nonce: string }) =>
    apiFetch<{ success: boolean; walletAddress: string }>(
      '/v1/portal/user/link-wallet/verify',
      { method: 'POST', body: data },
    ),
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
  // #7 operator-set pricing: per-node rate read + write. getNodeRate
  // returns the effective rate + allowed band; setNodeRate writes
  // the operator's chosen rate (null clears the override).
  getNodeRate: (id: string) =>
    apiFetch<{
      gpuTier: string
      effective: { ratePerHour: number; ratePerDay: number; source: 'operator' | 'custom' | 'floor' | 'none' }
      band: {
        minPerHour: number; minPerDay: number
        maxPerHour: number; maxPerDay: number
        floorPerHour: number; floorPerDay: number
      } | null
      operatorRatePerHour: number | null
      operatorRatePerDay: number | null
      operatorRateUpdatedAt: string | null
    }>(`/v1/portal/node-runner/nodes/${id}/rate`),
  setNodeRate: (id: string, ratePerHour: number | null) =>
    apiFetch<{
      success: boolean
      ratePerHour: number | null
      ratePerDay: number | null
      source: 'operator' | 'floor'
    }>(`/v1/portal/node-runner/nodes/${id}/rate`, { method: 'PATCH', body: { ratePerHour } }),
  pauseAll: () => apiFetch<{ success: boolean; count: number; message: string }>('/v1/portal/node-runner/nodes/pause-all', { method: 'POST' }),
  resumeAll: () => apiFetch<{ success: boolean; count: number; message: string }>('/v1/portal/node-runner/nodes/resume-all', { method: 'POST' }),
  earnings: (period?: string) => apiFetch(`/v1/portal/node-runner/earnings${period ? `?period=${period}` : ''}`),
  earningsHistory: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiFetch(`/v1/portal/node-runner/earnings/history${qs}`)
  },
  // C3 wave 2: 30-day earnings forecast based on the last 7 active
  // days. Cold-start cases (daysAnalyzed < 5) come back honest so the
  // UI can suppress the headline number until real data accrues.
  earningsForecast: (days = 30) =>
    apiFetch<{
      projected: number
      rangeLow: number
      rangeHigh: number
      avgDailyEarnings: number
      daysAnalyzed: number
      basedOn: string
      horizonDays: number
    }>(`/v1/portal/node-runner/earnings/forecast?days=${days}`),
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
  deploy: (data: {
    gpuTier: string
    nodeCount: number
    // USDC payments require txHash. BUYER_BALANCE omits it (server
    // generates BAL:<id>).
    txHash?: string
    paymentSource?: 'USDC' | 'BUYER_BALANCE'
    cryptoAmount?: number
    cryptoCurrency?: string
    deploymentNote?: string
  }) =>
    apiFetch('/v1/portal/node-runner/deploy', { method: 'POST', body: data }),
  // Card-payment alternative to deploy(). Returns a Stripe Hosted
  // Checkout URL; redirect the operator there, and the Stripe webhook
  // creates the Investment row once payment confirms server-side.
  deployStripeCheckout: (data: { gpuTier: string; nodeCount: number; deploymentNote?: string }) =>
    apiFetch<{ id: string; url: string }>('/v1/portal/node-runner/deploy/stripe/checkout', { method: 'POST', body: data }),
  deployments: () => apiFetch('/v1/portal/node-runner/deployments'),
  deployment: (id: string) => apiFetch(`/v1/portal/node-runner/deployments/${id}`),
  referral: () => apiFetch('/v1/portal/referral'),
  // C4 wave 1: trigger a benchmark run on a specific node. Writes a
  // one-shot Config flag on the API side; the agent picks it up on
  // the next heartbeat (≤30s), runs the benchmark Docker image, and
  // reports back to /v1/nodes/:id/benchmark/result which clears the
  // flag and updates the Node row. 429 if a benchmark ran <5 min ago.
  runBenchmark: (nodeId: string) =>
    apiFetch<{ nodeId: string; message: string }>(
      `/v1/portal/node-runner/nodes/${nodeId}/benchmark`,
      { method: 'POST', body: {} },
    ),
  // C7: tax / 1099 export. taxInfo() reads the operator's saved W-9
  // data (with TIN masked to last-4). updateTaxInfo() persists the
  // full TIN on the server. downloadTaxYear(year) fetches the CSV with
  // auth headers and opens a Blob URL for native browser save (same
  // pattern as the invoice download in commit 44e818e — bearer-token
  // routes can't be linked via plain <a href>).
  taxInfo: () =>
    apiFetch<{
      legalName: string
      taxIdType: 'SSN' | 'EIN' | null
      taxIdLast4: string
      taxIdSubmitted: boolean
      taxAddress: string
      taxJurisdiction: string
      w9SubmittedAt: string | null
    }>('/v1/portal/node-runner/tax-info'),
  updateTaxInfo: (data: {
    legalName: string
    taxIdType: 'SSN' | 'EIN'
    taxId: string
    taxAddress: string
    taxJurisdiction?: string
  }) =>
    apiFetch<{ ok: boolean; w9SubmittedAt: string | null }>(
      '/v1/portal/node-runner/tax-info',
      { method: 'PATCH', body: data },
    ),
  downloadTaxYear: async (year: number) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('a2e_access_token') : null
    const res = await fetch(`${API_URL}/v1/portal/node-runner/tax/year/${year}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }))
      throw new Error(body.message ?? `Tax CSV download failed: ${res.status}`)
    }
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `tax-${year}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  },
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
    // USDC payments require a txHash. INTERNAL_BALANCE and
    // BUYER_BALANCE rentals omit it (server generates INTERNAL:<id> /
    // BAL:<id>).
    txHash?: string
    // Payment source. USDC default; INTERNAL_BALANCE for dual-role
    // users paying from operator earnings; BUYER_BALANCE for any
    // buyer paying from pre-loaded credit (see /buyer/balance).
    paymentSource?: 'USDC' | 'INTERNAL_BALANCE' | 'BUYER_BALANCE'
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
    // C2 wave 2: buyer-declared workload type. Drives consumer-tier
    // eligibility in the allocator. Defaults to MIXED on the server,
    // so omitting it preserves pre-migration semantics.
    workloadType?: 'INFERENCE' | 'TRAINING' | 'MIXED'
    // Checkpoint Workspace restore: optional id of a prior rental's
    // READY checkpoint. Agent downloads + unpacks at provision time.
    restoreCheckpointId?: string | null
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
  // T5c: fetch the decrypted SSH credentials for a Lambda-provisioned
  // rental. 404 = not external (use legacy sshHost/sshPassword from the
  // request detail), 409 = still provisioning (poll again in a few s).
  externalCredentials: (id: string) =>
    apiFetch<{
      provider: string
      status: string
      sshHost: string
      sshPort: number
      sshUsername: string
      sshPrivateKey: string
      instanceType: string
      region: string
      launchedAt: string | null
    }>(`/v1/buyer/compute/requests/${id}/external-credentials`),
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

  // Credit balance: buyer pre-loads USD-denominated credit, rentals
  // draw from it. Backed by /v1/buyer/balance/* endpoints.
  balance: {
    get: () =>
      apiFetch<{
        balanceUsd: number
        totalToppedUp: number
        totalSpent: number
        totalRefunded: number
        currency: 'USD'
      }>('/v1/buyer/balance'),
    transactions: (limit = 25, cursor?: string) =>
      apiFetch<{
        transactions: Array<{
          id: string
          type: string
          amountUsd: number
          description: string
          referenceId: string | null
          balanceAfter: number
          createdAt: string
        }>
      }>(
        `/v1/buyer/balance/transactions?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      ),
    topupDestination: () =>
      apiFetch<{
        wallet: string | null
        currency: 'USDC'
        network: 'devnet' | 'mainnet'
        configured: boolean
        message?: string
      }>('/v1/buyer/balance/topup-destination'),
    topupSolana: (data: { txHash: string; amountUsd: number; note?: string }) =>
      apiFetch<{
        success: true
        creditedUsd?: number
        alreadyCredited?: boolean
        balance: {
          balanceUsd: number
          totalToppedUp: number
          totalSpent: number
          totalRefunded: number
        }
        devMode: boolean
      }>('/v1/buyer/balance/topup-solana', { method: 'POST', body: data }),

    // Fiat onramp: Stripe Hosted Checkout. Returns a session URL;
    // the caller redirects the browser to it. The actual balance
    // credit happens server-side via the /v1/webhooks/stripe handler
    // after Stripe confirms payment.
    topupStripeCheckout: (data: { amountUsd: number }) =>
      apiFetch<{ id: string; url: string }>(
        '/v1/buyer/balance/topup-stripe/checkout',
        { method: 'POST', body: data },
      ),
  },
  // Invoice route returns HTML. Bearer-token auth means we can't use a
  // plain <a href> — browsers don't attach the token to new-tab opens.
  // Fetch the HTML with auth, open in a new window via Blob URL so the
  // user can View / Print / Save as PDF natively.
  downloadInvoice: async (requestId: string) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('a2e_access_token') : null
    const res = await fetch(`${API_URL}/v1/buyer/billing/invoice/${requestId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      throw new Error(`Invoice fetch failed: ${res.status}`)
    }
    const html = await res.text()
    const blob = new Blob([html], { type: 'text/html' })
    const blobUrl = URL.createObjectURL(blob)
    // open in a new tab; revoke the URL after a delay so the browser
    // has time to load it (revoke immediately = blank page).
    window.open(blobUrl, '_blank')
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
  },
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
