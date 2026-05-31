// API Client for TokenOS DeAI Engine

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'
// Legacy fallback API key. Used only if no Bearer token is available
// (e.g. before login completes). Real admin requests authenticate with
// the HMAC token stored in localStorage by useAuth on successful login.
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || 'a2e-dev-key-2026'
const TOKEN_KEY = 'a2e_admin_token'

/**
 * Returns the auth headers to include on outgoing API requests.
 * Prefers the Bearer token from localStorage (set by useAuth.login).
 * Falls back to the X-API-Key header so unauthenticated public
 * endpoints (e.g. /health) still work and SSR contexts do not crash.
 */
function getAuthHeaders(): Record<string, string> {
  if (typeof window !== 'undefined') {
    const token = window.localStorage.getItem(TOKEN_KEY)
    if (token) return { Authorization: `Bearer ${token}` }
  }
  return { 'X-API-Key': API_KEY }
}

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>
}

async function apiFetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const { params, ...fetchOptions } = options

  let url = `${API_BASE}${endpoint}`
  if (params) {
    const searchParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.append(key, String(value))
      }
    })
    const queryString = searchParams.toString()
    if (queryString) {
      url += `?${queryString}`
    }
  }

  const hasBody = fetchOptions.body !== undefined && fetchOptions.body !== null
  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...getAuthHeaders(),
      ...fetchOptions.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }))
    throw new Error(error.message || `HTTP ${response.status}`)
  }

  // Handle 204 No Content responses
  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

// Health
export const api = {
  health: {
    check: () => apiFetch<{ status: string; timestamp: string }>('/health'),
    detailed: () => apiFetch<{ status: string; services: Record<string, unknown> }>('/health/detailed'),
  },

  // Nodes
  nodes: {
    list: (params?: { status?: string; gpuTier?: string; page?: number; limit?: number }) =>
      apiFetch<{
        nodes: Array<{
          id: string
          walletAddress: string
          gpuTier: string
          nodeType: string
          status: string
          region: string | null
          lastHeartbeat: string
          createdAt: string
        }>
        pagination: { page: number; limit: number; total: number; totalPages: number }
      }>('/v1/nodes', { params }),

    get: (id: string) => apiFetch<Record<string, unknown>>(`/v1/nodes/${id}`),

    register: (data: { walletAddress: string; gpuTier: string; nodeType?: string; region?: string }) =>
      apiFetch<{ id: string; walletAddress: string; gpuTier: string; status: string }>('/v1/nodes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    heartbeat: (id: string, data?: { gpuUtilization?: number; gpuTemperature?: number }) =>
      apiFetch<{ status: string; lastHeartbeat: string }>(`/v1/nodes/${id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify(data || {}),
      }),

    delete: async (id: string) => {
      const response = await fetch(`${API_BASE}/v1/nodes/${id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
      })
      // 404 is acceptable for delete - node may have been deleted via heartbeat
      if (!response.ok && response.status !== 404) {
        const error = await response.json().catch(() => ({ message: 'Request failed' }))
        throw new Error(error.message || `HTTP ${response.status}`)
      }
    },

    update: (id: string, data: { walletAddress?: string; region?: string }) =>
      apiFetch<{ id: string; walletAddress: string; region: string | null }>(`/v1/nodes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    updateStatus: (id: string, status: 'ONLINE' | 'PAUSED' | 'MAINTENANCE') =>
      apiFetch<{ id: string; status: string }>(`/v1/nodes/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
  },

  // Routing
  route: (data: { deploymentId: string; gpuTier: string; hasInternalDemand?: boolean }) =>
    apiFetch<{
      jobId: string
      deploymentId: string
      market: string
      ratePerHour: number
      ratePerDay: number
      reason: string
      yieldFloorApplied: boolean
      decisionTimeMs: number
      timestamp: string
    }>('/v1/route', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Jobs
  jobs: {
    list: (params?: { status?: string; market?: string; page?: number; limit?: number }) =>
      apiFetch<{
        jobs: Array<{
          id: string
          deploymentId: string
          gpuTier: string
          status: string
          market: string | null
          ratePerHour: number | null
          earnings: number | null
          cost: number | null
          profit: number | null
          requestedAt: string
        }>
        pagination: { page: number; limit: number; total: number; totalPages: number }
      }>('/v1/jobs', { params }),

    get: (id: string) => apiFetch<Record<string, unknown>>(`/v1/jobs/${id}`),

    update: (id: string, data: { nodeId?: string; status?: string; durationSeconds?: number }) =>
      apiFetch<{
        id: string
        status: string
        durationSeconds: number | null
        earnings: number | null
        updatedAt: string
      }>(`/v1/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    create: (data: {
      deploymentId: string
      gpuTier: string
      nodeId?: string
      hasInternalDemand?: boolean
      autoRoute?: boolean
    }) =>
      apiFetch<{
        id: string
        deploymentId: string
        gpuTier: string
        status: string
        nodeId: string | null
        queued: boolean
        createdAt: string
      }>('/v1/jobs', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    cancel: (id: string) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/jobs/${id}/cancel`, {
        method: 'POST',
      }),

    retry: (id: string) =>
      apiFetch<{ id: string; status: string; retryCount: number; message: string }>(`/v1/jobs/${id}/retry`, {
        method: 'POST',
      }),

    requeue: (id: string) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/jobs/${id}/requeue`, {
        method: 'POST',
      }),

    complete: (id: string, data: { durationSeconds: number; earnings?: number }) =>
      apiFetch<{ id: string; status: string; earnings: number }>(`/v1/jobs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'COMPLETED', ...data }),
      }),

    bulk: (jobs: Array<{ deploymentId: string; gpuTier: string; nodeId?: string }>) =>
      apiFetch<{
        success: boolean
        created: number
        failed: number
        jobs: Array<{ id: string; deploymentId: string; status: string } | { error: string; deploymentId: string }>
      }>('/v1/jobs/bulk', {
        method: 'POST',
        body: JSON.stringify({ jobs }),
      }),

    bulkCancel: (jobIds: string[]) =>
      apiFetch<{
        success: boolean
        cancelled: number
        failed: number
        results: Array<{ id: string; status: string } | { id: string; error: string }>
      }>('/v1/jobs/bulk/cancel', {
        method: 'POST',
        body: JSON.stringify({ jobIds }),
      }),
  },

  // Rates
  rates: {
    current: (params?: { gpuTier?: string; market?: string }) =>
      apiFetch<{
        rates: Array<{
          market: string
          gpuTier: string
          ratePerHour: number
          ratePerDay: number
          available: boolean
          enabled: boolean
          fetchedAt: string
        }>
        lastUpdated: string
      }>('/v1/rates', { params }),

    history: (params: { gpuTier: string; market: string; limit?: number }) =>
      apiFetch<{
        history: Array<{ ratePerHour: number; ratePerDay: number; fetchedAt: string }>
      }>('/v1/rates/history', { params }),
  },

  // Config
  config: {
    yieldFloors: () =>
      apiFetch<{
        floors: Array<{
          gpuTier: string
          ratePerHour: number
          ratePerDay: number
          isCustom: boolean
          defaultFloor: number
        }>
      }>('/v1/config/yield-floors'),

    updateYieldFloor: (data: { gpuTier: string; ratePerDay: number }) =>
      apiFetch<{ gpuTier: string; ratePerHour: number; ratePerDay: number }>('/v1/config/yield-floors', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    markets: () =>
      apiFetch<{
        markets: Array<{ market: string; enabled: boolean; priority: number }>
      }>('/v1/config/markets'),

    updateMarket: (data: { market: string; enabled?: boolean; priority?: number }) =>
      apiFetch<{ market: string; enabled: boolean; priority: number }>('/v1/config/markets', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    resetYieldFloor: (gpuTier: string) =>
      apiFetch<{ gpuTier: string; ratePerHour: number; ratePerDay: number; message: string }>(
        `/v1/config/yield-floors/${gpuTier}`,
        { method: 'DELETE' }
      ),

    updateMarketPriority: (markets: Array<{ market: string; priority: number }>) =>
      apiFetch<{ message: string; markets: Array<{ market: string; priority: number }> }>(
        '/v1/config/markets/priority',
        {
          method: 'PATCH',
          body: JSON.stringify({ markets }),
        }
      ),
  },

  // Stats
  stats: {
    overview: () =>
      apiFetch<{
        timestamp: string
        nodes: { total: number; byStatus: Record<string, number>; byTier: Record<string, number> }
        jobs: { total: number; byStatus: Record<string, number>; byMarket: Record<string, number>; last24h: number }
        routing: { decisionsLast24h: number; byMarket: Record<string, number>; avgDecisionTimeMs: number }
        earnings: { last24h: { total: number; gpuSeconds: number; jobCount: number } }
      }>('/v1/stats'),

    earningsTrend: (days: number = 7) =>
      apiFetch<{
        data: Array<{
          date: string
          internal: number
          akash: number
          ionet: number
          total: number
        }>
      }>('/v1/stats/earnings/trend', { params: { days } }),

    nodes: () =>
      apiFetch<{
        total: number
        byStatus: Record<string, number>
        byTier: Record<string, number>
        averageUptime: number
      }>('/v1/stats/nodes'),

    routing: () =>
      apiFetch<{
        total: number
        byMarket: Record<string, number>
        avgDecisionTimeMs: number
        yieldFloorHitRate: number
      }>('/v1/stats/routing'),
  },

  // Auth
  auth: {
    login: (username: string, password: string) =>
      apiFetch<{ token: string; user: { id: string; username: string; role: string } }>('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),

    verify: (token: string) =>
      apiFetch<{ valid: boolean; user: { id: string; username: string; role: string } }>('/v1/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),

    logout: () =>
      apiFetch<{ success: boolean }>('/v1/auth/logout', { method: 'POST' }),
  },

  // Config audit log
  configAudit: {
    list: (params?: { page?: number; limit?: number }) =>
      apiFetch<{
        logs: Array<{
          id: string
          action: string
          field: string
          oldValue: string
          newValue: string
          changedBy: string
          changedAt: string
        }>
        pagination: { page: number; limit: number; total: number }
      }>('/v1/config/audit', { params }),
  },

  // Financial - Earnings
  earnings: {
    list: (params?: { nodeId?: string; market?: string; startDate?: string; endDate?: string; limit?: number; offset?: number }) =>
      apiFetch<{
        earnings: Array<{
          id: string
          nodeId: string
          walletAddress: string
          gpuTier: string
          date: string
          market: string
          earnings: number
          gpuSeconds: number
          jobCount: number
        }>
        total: number
        limit: number
        offset: number
      }>('/v1/earnings', { params }),

    summary: (params?: { startDate?: string; endDate?: string }) =>
      apiFetch<{
        totalEarnings: number
        totalGpuSeconds: number
        totalJobs: number
        byMarket: Record<string, { earnings: number; jobs: number }>
        byNode: Record<string, { earnings: number; jobs: number }>
      }>('/v1/earnings/summary', { params }),

    byNode: (nodeId: string, params?: { days?: number; startDate?: string; endDate?: string }) =>
      apiFetch<{
        node: { id: string; walletAddress: string; gpuTier: string }
        period: { start: string; end: string }
        totals: { earnings: number; gpuHours: number; jobCount: number }
        daily: Array<{
          date: string
          market: string
          earnings: number
          gpuSeconds: number
          jobCount: number
        }>
      }>(`/v1/earnings/by-node/${nodeId}`, { params }),

    byMarket: (params?: { days?: number }) =>
      apiFetch<{
        period: { start: string; end: string }
        total: { earnings: number; gpuHours: number; jobCount: number }
        byMarket: Record<string, { earnings: number; gpuHours: number; jobCount: number }>
      }>('/v1/earnings/by-market', { params }),

    byTier: (params?: { days?: number; startDate?: string; endDate?: string }) =>
      apiFetch<{
        period: { start: string; end: string }
        byTier: Record<string, { earnings: number; gpuHours: number; jobCount: number }>
      }>('/v1/earnings/by-tier', { params }),

    trends: (params?: { days?: number; groupBy?: string }) =>
      apiFetch<{
        period: { start: string; end: string; days: number; groupBy: string }
        trend: Array<{ date: string; earnings: number; gpuHours: number; jobCount: number }>
      }>('/v1/earnings/trends', { params }),
  },

  // Financial - Costs
  costs: {
    list: (params?: { category?: string; limit?: number }) =>
      apiFetch<{
        costs: Array<{
          id: string
          nodeId: string | null
          category: string
          amount: number
          currency: string
          description: string | null
          periodStart: string
          periodEnd: string
          createdAt: string
        }>
        total: number
      }>('/v1/costs', { params }),

    summary: (params?: { days?: number }) =>
      apiFetch<{
        period: { start: string; end: string }
        total: number
        byCategory: Record<string, number>
      }>('/v1/costs/summary', { params }),

    create: (data: {
      category: string
      amount: number
      description?: string
      periodStart: string
      periodEnd: string
      nodeId?: string
    }) =>
      apiFetch<{ id: string }>('/v1/costs', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    delete: (id: string) =>
      apiFetch<{ success: boolean }>(`/v1/costs/${id}`, { method: 'DELETE' }),
  },

  // Financial - Margins
  margins: (params?: { days?: number }) =>
    apiFetch<{
      period: { start: string; end: string }
      revenue: number
      costs: number
      profit: number
      marginPercent: number
    }>('/v1/margins', { params }),

  // Financial - Settlements
  settlements: {
    list: (params?: { status?: string; limit?: number }) =>
      apiFetch<{
        settlements: Array<{
          id: string
          nodeId: string
          walletAddress: string
          gpuTier: string
          amount: number
          currency: string
          status: string
          jobCount: number
          periodStart: string
          periodEnd: string
          txHash: string | null
          txConfirmed: boolean
          createdAt: string
          processedAt: string | null
        }>
        total: number
      }>('/v1/settlements', { params }),

    pending: () =>
      apiFetch<{
        pendingCount: number
        totalAmount: number
        pending: Array<{
          nodeId: string
          walletAddress: string
          amount: number
          jobCount: number
        }>
      }>('/v1/settlements/pending'),

    config: () =>
      apiFetch<{
        period: string
        minimumPayout: number
        dayOfWeek: number | null
        dayOfMonth: number | null
        hour: number
        autoSchedule: boolean
        lastScheduledAt: string | null
        solanaRpcUrl: string | null
        usdcMint: string | null
      }>('/v1/settlements/config'),

    updateConfig: (data: {
      period?: 'daily' | 'weekly' | 'monthly'
      minimumPayout?: number
      dayOfWeek?: number | null
      dayOfMonth?: number | null
      hour?: number
      autoSchedule?: boolean
      solanaRpcUrl?: string
      payerPrivateKey?: string
      usdcMint?: string
    }) =>
      apiFetch<{
        period: string
        minimumPayout: number
        dayOfWeek: number | null
        dayOfMonth: number | null
        hour: number
        autoSchedule: boolean
      }>('/v1/settlements/config', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    failed: () =>
      apiFetch<{
        retriable: Array<{
          id: string
          nodeId: string
          walletAddress: string
          amount: number
          status: string
          retryCount: number
          maxRetries: number
          nextRetryAt: string | null
          createdAt: string
        }>
        exhausted: Array<{
          id: string
          nodeId: string
          walletAddress: string
          amount: number
          status: string
          retryCount: number
          maxRetries: number
          nextRetryAt: string | null
          createdAt: string
        }>
      }>('/v1/settlements/failed'),

    trigger: (nodeId?: string) =>
      apiFetch<{ message: string; settlementIds: string[] }>('/v1/settlements/trigger', {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      }),

    get: (id: string) =>
      apiFetch<{
        id: string
        nodeId: string
        walletAddress: string
        gpuTier: string
        amount: number
        currency: string
        status: string
        jobCount: number
        periodStart: string
        periodEnd: string
        txHash: string | null
        txConfirmed: boolean
        createdAt: string
        processedAt: string | null
        jobs: Array<{
          id: string
          deploymentId: string
          earnings: number
          durationSeconds: number
          completedAt: string
        }>
        payment: {
          id: string
          txHash: string
          status: string
          confirmedAt: string | null
        } | null
      }>(`/v1/settlements/${id}`),

    complete: (id: string, txHash: string) =>
      apiFetch<{ message: string }>(`/v1/settlements/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ txHash }),
      }),

    fail: (id: string, reason: string) =>
      apiFetch<{ message: string }>(`/v1/settlements/${id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    retry: (id: string) =>
      apiFetch<{ message: string; settlementId: string }>(`/v1/settlements/${id}/retry`, {
        method: 'POST',
      }),
  },

  // Financial - Payments
  payments: {
    mode: () =>
      apiFetch<{
        mode: 'dev' | 'live'
        description: string
        devMode: boolean
        rpcConfigured: boolean
        payerConfigured: boolean
      }>('/v1/payments/mode'),

    list: (params?: { status?: string; limit?: number; page?: number }) =>
      apiFetch<{
        payments: Array<{
          id: string
          settlementId: string
          amount: number
          currency: string
          recipientAddress: string
          txHash: string | null
          status: string
          isDevMode: boolean
          createdAt: string
          confirmedAt: string | null
        }>
        pagination: { page: number; limit: number; total: number; totalPages: number }
      }>('/v1/payments', { params }),

    get: (id: string) =>
      apiFetch<{
        id: string
        settlementId: string
        amount: number
        currency: string
        recipientAddress: string
        txHash: string | null
        status: string
        isDevMode: boolean
        confirmations: number
        createdAt: string
        confirmedAt: string | null
        settlement: {
          id: string
          nodeId: string
          walletAddress: string
          jobCount: number
        }
      }>(`/v1/payments/${id}`),

    process: (settlementId: string, currency: 'SOL' | 'USDC' = 'USDC') =>
      apiFetch<{
        success: boolean
        paymentId: string
        settlementId: string
        txHash: string
        amount: number
        currency: string
        recipientAddress: string
        isDevMode: boolean
        status: string
        message: string
      }>(`/v1/payments/process/${settlementId}`, {
        method: 'POST',
        body: JSON.stringify({ currency }),
      }),

    batch: (settlementIds: string[], currency: 'SOL' | 'USDC' = 'USDC') =>
      apiFetch<{
        success: boolean
        processed: number
        failed: number
        results: Array<{
          settlementId: string
          paymentId?: string
          txHash?: string
          error?: string
        }>
      }>('/v1/payments/batch', {
        method: 'POST',
        body: JSON.stringify({ settlementIds, currency }),
      }),

    verify: (txHash: string) =>
      apiFetch<{
        verified: boolean
        confirmations: number
        status: string
        blockTime: string | null
      }>(`/v1/payments/verify/${txHash}`, {
        method: 'POST',
      }),

    stats: () =>
      apiFetch<{
        currentMode: string
        modeDescription: string
        stats: {
          total: number
          confirmed: number
          failed: number
          devModePayments: number
          totalAmountPaid: number
        }
      }>('/v1/payments/stats'),

    balance: () =>
      apiFetch<{
        isDevMode: boolean
        balances: {
          sol: number
          usdc: number
        }
        error?: string
        message: string
      }>('/v1/payments/balance'),

    batchOnchain: (settlementIds: string[], currency: 'SOL' | 'USDC' = 'USDC') =>
      apiFetch<{
        success: boolean
        txHash?: string
        processed: number
        totalAmount: number
        currency: string
        isDevMode: boolean
        isBatched: boolean
        paymentIds?: string[]
        errors?: Array<{ settlementId: string; error: string }>
        message: string
      }>('/v1/payments/batch-onchain', {
        method: 'POST',
        body: JSON.stringify({ settlementIds, currency }),
      }),
  },

  // Financial - Reports
  reports: {
    summary: (params?: { days?: number }) =>
      apiFetch<{
        period: { start: string; end: string }
        revenue: { total: number; gpuHours: number; jobCount: number }
        costs: { total: number }
        profit: { gross: number; margin: number }
        settlements: { completed: number; amount: number }
        activity: { totalJobs: number; activeNodes: number }
      }>('/v1/reports/summary', { params }),

    downloadCSV: async (type: 'earnings' | 'settlements' | 'jobs' | 'nodes') => {
      const response = await fetch(`${API_BASE}/v1/reports/${type}/csv`, {
        headers: getAuthHeaders(),
      })
      if (!response.ok) throw new Error('Failed to download CSV')
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${type}-${new Date().toISOString().split('T')[0]}.csv`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    },

    downloadPDF: async (type: 'earnings' | 'settlements' | 'invoice', params?: { nodeId?: string; startDate?: string; endDate?: string }) => {
      const queryParams = new URLSearchParams()
      if (params?.nodeId) queryParams.append('nodeId', params.nodeId)
      if (params?.startDate) queryParams.append('startDate', params.startDate)
      if (params?.endDate) queryParams.append('endDate', params.endDate)
      const queryString = queryParams.toString()
      const url = `${API_BASE}/v1/reports/${type}/pdf${queryString ? `?${queryString}` : ''}`

      const response = await fetch(url, {
        headers: getAuthHeaders(),
      })
      if (!response.ok) throw new Error('Failed to download PDF')
      const blob = await response.blob()
      const blobUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `a2e-${type}-${new Date().toISOString().split('T')[0]}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(blobUrl)
      document.body.removeChild(a)
    },

    nodeStatement: async (nodeId: string, params?: { days?: number; startDate?: string; endDate?: string }) => {
      const queryParams = new URLSearchParams()
      if (params?.days) queryParams.append('days', String(params.days))
      if (params?.startDate) queryParams.append('startDate', params.startDate)
      if (params?.endDate) queryParams.append('endDate', params.endDate)
      const queryString = queryParams.toString()
      const url = `${API_BASE}/v1/reports/statement/${nodeId}${queryString ? `?${queryString}` : ''}`

      const response = await fetch(url, {
        headers: getAuthHeaders(),
      })
      if (!response.ok) throw new Error('Failed to generate statement')
      const html = await response.text()

      // Open in new window for printing
      const printWindow = window.open('', '_blank')
      if (printWindow) {
        printWindow.document.write(html)
        printWindow.document.close()
      }
      return html
    },
  },

  // Node Provisioning
  provision: {
    start: (data: {
      host: string
      port: number
      username: string
      authMethod: 'password' | 'privateKey'
      password?: string
      privateKey?: string
      passphrase?: string
      gpuTier: string
      nodeName?: string
      region?: string
      customGpuModel?: string
      customRatePerDay?: number
      testMode?: boolean
    }) =>
      apiFetch<{
        provisionId: string
        status: string
        message: string
      }>('/v1/nodes/provision', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    getStatus: (id: string) =>
      apiFetch<{
        provisionId: string
        status: string
        currentStep: number
        totalSteps: number
        currentAction: string
        logs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; message: string }>
        node?: { id: string }
        error?: string
        startedAt?: string
        completedAt?: string
      }>(`/v1/nodes/provision/${id}`),

    list: (params?: { status?: string; limit?: number }) =>
      apiFetch<{
        jobs: Array<{
          id: string
          status: string
          host: string
          gpuTier: string
          nodeName: string | null
          currentStep: number
          totalSteps: number
          currentAction: string | null
          nodeId: string | null
          error: string | null
          createdAt: string
          startedAt: string | null
          completedAt: string | null
        }>
        total: number
      }>('/v1/nodes/provision', { params }),

    cancel: (id: string) =>
      apiFetch<{ success: boolean; message: string }>(`/v1/nodes/provision/${id}`, {
        method: 'DELETE',
      }),
  },

  // Node Runners
  nodeRunners: {
    list: () =>
      apiFetch<{
        nodeRunners: Array<{
          id: string
          name: string
          email: string | null
          walletAddress: string
          nodeCount: number
          totalInvested: number
          createdAt: string
        }>
        total: number
      }>('/v1/node-runners'),

    get: (id: string) =>
      apiFetch<{
        id: string
        name: string
        email: string | null
        walletAddress: string
        createdAt: string
        payoutLockUntil: string | null
        payoutLockReason: string | null
        financials: {
          totalInvested: number
          totalEarnings: number
          totalPayouts: number
          pendingPayout: number
          netPosition: number
          roiPercentage: number
        }
        nodes: Array<{
          id: string
          gpuTier: string
          status: string
          createdAt: string
        }>
        nodeEarnings: Array<{
          nodeId: string
          gpuTier: string
          uptimeHours: number
          earnings: number
        }>
        investments: Array<{
          id: string
          amount: number
          currency: string
          cryptoAmount: number | null
          cryptoCurrency: string | null
          txHash: string | null
          gpuTier: string
          status: string
          createdAt: string
          confirmedAt: string | null
          provisionedAt: string | null
        }>
      }>(`/v1/node-runners/${id}`),

    setPayoutLock: (id: string, body: { lockedUntil: string | null; reason?: string }) =>
      apiFetch<{ nodeRunnerId: string; lockedUntil: string | null; reason: string | null }>(
        `/v1/node-runners/${id}/payout-lock`,
        { method: 'PATCH', body: JSON.stringify(body) }
      ),

    create: (data: { name: string; email?: string; walletAddress: string }) =>
      apiFetch<{
        id: string
        name: string
        email: string | null
        walletAddress: string
        createdAt: string
      }>('/v1/node-runners', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    roi: (id: string, params?: { days?: number }) =>
      apiFetch<{
        nodeRunnerId: string
        period: { days: number; start: string | null; end: string | null }
        summary: {
          totalInvested: number
          totalEarnings: number
          totalUptimeHours: number
          avgDailyEarnings: number
          roiPercentage: number
        }
        projections: {
          daysToBreakeven: number | null
          projectedMonthlyEarnings: number
          projectedYearlyEarnings: number
        }
        daily: Array<{ date: string; uptimeHours: number; earnings: number }>
      }>(`/v1/node-runners/${id}/roi`, { params }),

    // Get node runner by wallet address (for portal login)
    getByWallet: (walletAddress: string) =>
      apiFetch<{
        id: string
        name: string
        email: string | null
        walletAddress: string
      }>(`/v1/node-runners/wallet/${walletAddress}`),

    update: (id: string, data: { name?: string; email?: string; walletAddress?: string }) =>
      apiFetch<{
        id: string
        name: string
        email: string | null
        walletAddress: string
        updatedAt: string
      }>(`/v1/node-runners/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    delete: async (id: string) => {
      const response = await fetch(`${API_BASE}/v1/node-runners/${id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Request failed' }))
        throw new Error(error.message || `HTTP ${response.status}`)
      }
    },
  },

  // Investments
  investments: {
    list: (params?: { status?: string; nodeRunnerId?: string }) =>
      apiFetch<{
        investments: Array<{
          id: string
          nodeRunnerName: string
          walletAddress: string
          amount: number
          currency: string
          cryptoAmount: number | null
          cryptoCurrency: string | null
          txHash: string | null
          gpuTier: string
          status: string
          nodeId: string | null
          createdAt: string
          confirmedAt: string | null
          provisionedAt: string | null
          installToken: string | null
          installCommand: string | null
        }>
        total: number
      }>('/v1/investments', { params }),

    create: (data: {
      nodeRunnerId: string
      amount: number
      currency?: string
      cryptoAmount?: number
      cryptoCurrency?: string
      txHash?: string
      gpuTier: string
    }) =>
      apiFetch<{
        id: string
        nodeRunnerId: string
        amount: number
        gpuTier: string
        status: string
        createdAt: string
      }>('/v1/investments', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    confirm: (id: string, data: { txHash: string; cryptoAmount?: number; cryptoCurrency?: string }) =>
      apiFetch<{
        id: string
        status: string
        txHash: string
        confirmedAt: string
      }>(`/v1/investments/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    linkNode: (id: string, nodeId: string) =>
      apiFetch<{
        investmentId: string
        nodeId: string
        nodeRunnerId: string
        status: string
        message: string
      }>(`/v1/investments/${id}/link-node`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      }),

    cancel: (id: string) =>
      apiFetch<{
        id: string
        status: string
        message: string
      }>(`/v1/investments/${id}/cancel`, {
        method: 'POST',
      }),

    // Admin: mint a fresh BYOG install token for this Investment. Used
    // when the auto-minted one was consumed by the wrong machine,
    // expired, or never created (legacy rows pre-auto-mint).
    regenerateInstallToken: (id: string) =>
      apiFetch<{
        id: string
        installToken: string
        installCommand: string
        expiresAt: string
      }>(`/v1/investments/${id}/regenerate-install-token`, {
        method: 'POST',
      }),
  },

  // System
  system: {
    health: () =>
      apiFetch<{
        status: string
        timestamp: string
        services: {
          database: { status: string; latencyMs: number }
          redis: { status: string; latencyMs: number; memoryUsage?: string }
          jobQueue: { status: string; waiting: number; active: number; completed: number; failed: number }
          rateFetcher: { status: string; lastRun: string | null; nextRun: string | null }
        }
        uptime: number
        version: string
      }>('/v1/system/health'),

    logs: (params?: { level?: string; limit?: number }) =>
      apiFetch<{
        logs: Array<{
          id: string
          level: string
          message: string
          context: Record<string, unknown>
          timestamp: string
        }>
      }>('/v1/system/logs', { params }),
  },

  // Audit & Reconciliation
  audit: {
    list: (params?: { entityType?: string; action?: string; limit?: number; offset?: number }) =>
      apiFetch<{
        logs: Array<{
          id: string
          entityType: string
          entityId: string
          action: string
          previousValue: Record<string, unknown> | null
          newValue: Record<string, unknown> | null
          actor: string | null
          actorType: string
          reason: string | null
          createdAt: string
        }>
        total: number
        limit: number
        offset: number
      }>('/v1/audit', { params }),

    getByEntity: (entityType: string, entityId: string, params?: { limit?: number }) =>
      apiFetch<{
        entityType: string
        entityId: string
        logs: Array<{
          id: string
          action: string
          previousValue: Record<string, unknown> | null
          newValue: Record<string, unknown> | null
          actor: string | null
          actorType: string
          reason: string | null
          createdAt: string
        }>
        total: number
      }>(`/v1/audit/${entityType}/${entityId}`, { params }),
  },

  // Deployments
  deployments: {
    list: (status?: string) =>
      apiFetch<{
        deployments: Array<{
          id: string
          nodeRunnerId: string
          amount: number
          currency: string
          nodeCount: number
          gpuTier: string
          status: string
          txHash: string | null
          nodeId: string | null
          deploymentNote: string | null
          sshHost: string | null
          sshPort: number | null
          sshUsername: string | null
          provisionJobId: string | null
          createdAt: string
          confirmedAt: string | null
          deploymentRequestedAt: string | null
          provisionedAt: string | null
          nodeRunner: { id: string; name: string; email: string | null; walletAddress: string } | null
        }>
        pendingCount: number
      }>(`/v1/admin/deployments${status ? `?status=${status}` : ''}`),

    get: (id: string) =>
      apiFetch<{
        id: string
        nodeRunnerName: string
        walletAddress: string
        gpuTier: string
        nodeCount: number
        amount: number
        currency: string
        txHash: string | null
        status: string
        provisionId: string | null
        nodeId: string | null
        sshHost: string | null
        sshPort: number | null
        sshUsername: string | null
        cancelReason: string | null
        createdAt: string
        updatedAt: string
      }>(`/v1/admin/deployments/${id}`),

    submitSsh: (id: string, data: {
      host: string
      port: number
      username: string
      authMethod: string
      password?: string
      privateKey?: string
      testMode?: boolean
    }) =>
      apiFetch<{
        id: string
        status: string
        provisionId: string
        message: string
      }>(`/v1/admin/deployments/${id}/ssh`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    cancel: (id: string, reason?: string) =>
      apiFetch<{
        id: string
        status: string
        message: string
      }>(`/v1/admin/deployments/${id}/cancel`, {
        method: 'PATCH',
        body: JSON.stringify({ reason }),
      }),

    complete: (id: string, nodeId: string) =>
      apiFetch<{
        id: string
        status: string
        nodeId: string
        message: string
      }>(`/v1/admin/deployments/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      }),
  },

  // Compute Requests
  compute: {
    list: (status?: string) =>
      apiFetch<{
        requests: Array<{
          id: string
          user?: { id: string; email: string | null; walletAddress: string | null }
          gpuTier: string
          gpuCount: number
          durationDays: number
          totalCost: number
          status: string
          sshHost: string | null
          sshPort: number | null
          sshUsername: string | null
          sshPassword: string | null
          allocatedNodeIds: string[]
          adminNote: string | null
          requestedAt: string
        }>
        counts: {
          pending: number
          approved: number
          allocated: number
          active: number
          completed: number
          cancelled: number
          rejected: number
          waitlisted: number
          terminated: number
        }
        total: number
      }>('/v1/admin/compute/requests', { params: status ? { status } : undefined }),

    get: (id: string) =>
      apiFetch<{
        id: string
        buyerEmail: string
        gpuTier: string
        gpuCount: number
        durationDays: number
        totalCost: number
        status: string
        sshHost: string | null
        sshPort: number | null
        sshUsername: string | null
        sshPassword: string | null
        nodeIds: string[] | null
        adminNote: string | null
        rejectReason: string | null
        createdAt: string
        updatedAt: string
      }>(`/v1/admin/compute/requests/${id}`),

    availability: () =>
      apiFetch<{
        availability: Record<string, { total: number; idle: number; busy: number }>
      }>('/v1/admin/compute/availability'),

    approve: (id: string, note?: string) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/admin/compute/requests/${id}/approve`, {
        method: 'PATCH',
        body: JSON.stringify({ note }),
      }),

    // M2: flip a WAITLISTED request back to PENDING so the auto-allocator
    // picks it up on the next 10s tick.
    releaseHold: (id: string, note?: string) =>
      apiFetch<{ id: string; status: string }>(`/v1/admin/compute/requests/${id}/release-hold`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),

    autoAllocate: (id: string) =>
      apiFetch<{ id: string; status: string; nodesAllocated: number; message: string }>(`/v1/admin/compute/requests/${id}/auto-allocate`, {
        method: 'POST',
      }),

    allocate: (id: string, data: { nodeIds: string[]; sshHost: string; sshPort: number; sshUsername: string; sshPassword: string }) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/admin/compute/requests/${id}/allocate`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    activate: (id: string, sshDetails?: { sshHost: string; sshPort: number; sshUsername: string; sshPassword: string }) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/admin/compute/requests/${id}/activate`, {
        method: 'PATCH',
        body: JSON.stringify(sshDetails || {}),
      }),

    reject: (id: string, reason?: string) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/admin/compute/requests/${id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify({ reason }),
      }),

    complete: (id: string) =>
      apiFetch<{ id: string; status: string; message: string }>(`/v1/admin/compute/requests/${id}/complete`, {
        method: 'PATCH',
      }),
  },

  // M3 admin ratings moderation
  ratings: {
    list: (status?: string) =>
      apiFetch<{
        ratings: Array<{
          id: string
          score: number
          comment: string | null
          moderationStatus: 'PENDING' | 'APPROVED' | 'REJECTED'
          moderationNote: string | null
          createdAt: string
          buyer: { id: string; email: string | null; walletAddress: string | null } | null
          nodeRunner: { id: string; name: string; slug: string | null }
          computeRequest: {
            id: string
            gpuTier: string
            gpuCount: number
            durationDays: number
            totalCost: number
            tier: string
            completedAt: string | null
          }
        }>
        counts: { pending: number; approved: number; rejected: number }
      }>(`/v1/admin/ratings${status ? `?status=${status}` : ''}`),
    approve: (id: string) =>
      apiFetch<{ id: string; moderationStatus: string }>(`/v1/admin/ratings/${id}/approve`, {
        method: 'PATCH',
      }),
    reject: (id: string, note?: string) =>
      apiFetch<{ id: string; moderationStatus: string }>(`/v1/admin/ratings/${id}/reject`, {
        method: 'PATCH',
        body: JSON.stringify({ note }),
      }),
  },

  // Withdrawals
  withdrawals: {
    list: (status?: string) =>
      apiFetch<{ withdrawals: any[]; counts: any }>(`/v1/admin/withdrawals${status ? `?status=${status}` : ''}`),
    get: (id: string) =>
      apiFetch<any>(`/v1/admin/withdrawals/${id}`),
    approve: (id: string) =>
      apiFetch<any>(`/v1/admin/withdrawals/${id}/approve`, { method: 'PATCH' }),
    process: (id: string) =>
      apiFetch<any>(`/v1/admin/withdrawals/${id}/process`, { method: 'PATCH' }),
    complete: (id: string, txHash: string) =>
      apiFetch<any>(`/v1/admin/withdrawals/${id}/complete`, { method: 'PATCH', body: JSON.stringify({ txHash }) }),
    // T3.2.1a: one-click Stripe Transfer for STRIPE_CONNECT withdrawals.
    // Backend calls stripe.transfers.create() end-to-end and marks
    // the row COMPLETED + records the tr_xxxxxx id.
    processStripe: (id: string) =>
      apiFetch<{ id: string; status: string; stripeTransferId: string }>(
        `/v1/admin/withdrawals/${id}/process-stripe`,
        { method: 'PATCH' },
      ),
    reject: (id: string, reason?: string) =>
      apiFetch<any>(`/v1/admin/withdrawals/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  },

  // T1 — admin credit balance (TOPUP_ADMIN) for early testers,
  // promo grants, support refunds. See routes/admin-balance.ts.
  adminBalance: {
    searchUsers: (q?: string) =>
      apiFetch<{
        users: Array<{
          id: string
          email: string | null
          walletAddress: string | null
          role: string
          isBuyer: boolean
          createdAt: string
          balanceUsd: number
        }>
      }>(`/v1/admin/balance/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),

    get: (userId: string) =>
      apiFetch<{
        user: { id: string; email: string | null; walletAddress: string | null; role: string }
        balance: { balanceUsd: number; totalToppedUp: number; totalSpent: number; totalRefunded: number }
        transactions: Array<{
          id: string
          type: string
          amountUsd: number
          description: string
          referenceId: string | null
          balanceAfter: number
          createdAt: string
        }>
      }>(`/v1/admin/balance/${userId}`),

    credit: (body: { userId: string; amountUsd: number; description: string; referenceId?: string }) =>
      apiFetch<{
        ok: boolean
        userId: string
        amountUsd: number
        newBalanceUsd: number
        referenceId: string
        transactionId: string | null
        createdAt: string | null
        duplicate: boolean
      }>(`/v1/admin/balance/credit`, { method: 'POST', body: JSON.stringify(body) }),
  },

  // External Markets (M7)
  external: {
    status: () =>
      apiFetch<{
        simulationMode: boolean
        overflow: {
          enabled: boolean
          idleThresholdMinutes: number
          demandThresholdPercent: number
          marginProtectionPercent: number
          gracePeriodSeconds: number
        }
        markets: Array<{
          market: 'AKASH' | 'IONET' | 'VASTAI'
          enabled: boolean
          healthy: boolean
          autoDisabled: boolean
          failureCount: number
          lastSuccess: string | null
          lastFailure: string | null
          lastError: string | null
          latestRates: Record<string, { ratePerHour: number; available: boolean } | null>
        }>
      }>('/v1/external/status'),

    deployments: (params?: { status?: string }) =>
      apiFetch<{
        deployments: Array<{
          id: string
          nodeId: string
          market: 'AKASH' | 'IONET' | 'VASTAI'
          externalId: string
          status: 'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED'
          ratePerHour: number
          costAccumulated: number
          earningsAccumulated: number
          createdAt: string
          terminatedAt: string | null
          lastCheckedAt: string
          terminationMode: string | null
          terminationReason: string | null
          node: { id: string; gpuTier: string; walletAddress: string }
        }>
        counts: Record<'PENDING' | 'ACTIVE' | 'TERMINATING' | 'TERMINATED' | 'FAILED', number>
      }>('/v1/external/deployments', { params }),

    deployment: (id: string) =>
      apiFetch<{
        deployment: {
          id: string
          nodeId: string
          market: 'AKASH' | 'IONET' | 'VASTAI'
          externalId: string
          status: string
          ratePerHour: number
          costAccumulated: number
          earningsAccumulated: number
          createdAt: string
          terminatedAt: string | null
          lastCheckedAt: string
          node: { id: string; gpuTier: string; walletAddress: string }
        }
        jobs: Array<{
          id: string
          status: string
          earnings: number | null
          cost: number | null
          createdAt: string
        }>
      }>(`/v1/external/deployments/${id}`),

    listNode: (nodeId: string, body?: { market?: 'AKASH' | 'IONET' | 'VASTAI' }) =>
      apiFetch<{
        deploymentId: string
        externalId: string
        status: string
        market: 'AKASH' | 'IONET' | 'VASTAI'
        ratePerHour: number
      }>(`/v1/external/list/${nodeId}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),

    delistNode: (nodeId: string, mode: 'safe' | 'force', reason: string) =>
      apiFetch<{ status: string; terminated: boolean; deploymentId: string }>(
        `/v1/external/list/${nodeId}?mode=${mode}&reason=${encodeURIComponent(reason)}`,
        { method: 'DELETE' },
      ),

    earnings: (params?: { from?: string; to?: string; nodeId?: string; market?: string }) =>
      apiFetch<{
        totalUsd: number
        byMarket: Record<'AKASH' | 'IONET' | 'VASTAI', number>
        byNode: Array<{ nodeId: string; walletAddress: string; totalUsd: number }>
        periodStart: string
        periodEnd: string
      }>('/v1/external/earnings', { params }),

    getConfig: () =>
      apiFetch<{
        config: {
          id: string
          enabled: boolean
          simulationMode: boolean
          idleThresholdMinutes: number
          demandThresholdPercent: number
          marginProtectionPercent: number
          gracePeriodSeconds: number
          preferredMarkets: Array<'AKASH' | 'IONET' | 'VASTAI'>
          createdAt: string
          updatedAt: string
        }
      }>('/v1/external/config'),

    updateConfig: (body: Partial<{
      enabled: boolean
      simulationMode: boolean
      idleThresholdMinutes: number
      demandThresholdPercent: number
      marginProtectionPercent: number
      gracePeriodSeconds: number
      preferredMarkets: Array<'AKASH' | 'IONET' | 'VASTAI'>
    }>) =>
      apiFetch<{
        config: {
          id: string
          enabled: boolean
          simulationMode: boolean
          idleThresholdMinutes: number
          demandThresholdPercent: number
          marginProtectionPercent: number
          gracePeriodSeconds: number
          preferredMarkets: Array<'AKASH' | 'IONET' | 'VASTAI'>
        }
      }>('/v1/external/config', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  },

  smtp: {
    get: () =>
      apiFetch<{
        host: string
        port: number
        secure: boolean
        username: string
        fromAddress: string
        configured: boolean
      }>('/v1/admin/smtp'),

    update: (data: {
      host?: string
      port?: number
      secure?: boolean
      username?: string
      password?: string
      fromAddress?: string
    }) =>
      apiFetch<{ message: string }>('/v1/admin/smtp', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    test: (email: string) =>
      apiFetch<{ message: string; success: boolean }>('/v1/admin/smtp/test', {
        method: 'POST',
        body: JSON.stringify({ to: email }),
      }),
  },

  // BYOG install tokens. The portal mints these per-operator; the admin
  // page surfaces every issued token plus a revoke button for typos and
  // leaked URLs (e.g. wrong operator email). Revoke is a soft kill —
  // the token row stays for audit, expiresAt is moved to the past.
  installTokens: {
    list: () =>
      apiFetch<{
        tokens: Array<{
          id: string
          token: string
          region: string | null
          createdAt: string
          expiresAt: string
          consumedAt: string | null
          consumedByNodeId: string | null
          status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED'
          nodeRunner: { id: string; name: string; email: string | null } | null
        }>
        counts: { active: number; consumed: number; expired: number; total: number }
      }>('/v1/admin/install-tokens'),

    revoke: (id: string) =>
      apiFetch<{ id: string; revoked: boolean; expiresAt: string }>(
        `/v1/admin/install-tokens/${id}`,
        { method: 'DELETE' }
      ),
  },

  reconciliation: {
    status: () =>
      apiFetch<{
        pending: number
        verified: number
        failed: number
        notFound: number
        manual: number
        lastRunAt: string | null
        totalProcessed: number
      }>('/v1/reconciliation/status'),

    run: () =>
      apiFetch<{
        message: string
        result: {
          processed: number
          verified: number
          failed: number
          notFound: number
        }
        status: {
          pending: number
          verified: number
          failed: number
          notFound: number
          manual: number
        }
      }>('/v1/reconciliation/run', { method: 'POST' }),

    orphaned: (params?: { staleMinutes?: number }) =>
      apiFetch<{
        count: number
        staleMinutes: number
        payments: Array<{
          id: string
          settlementId: string
          txHash: string | null
          amount: number
          recipientAddress: string
          createdAt: string
        }>
      }>('/v1/reconciliation/orphaned', { params }),

    pending: (params?: { status?: string; limit?: number }) =>
      apiFetch<{
        count: number
        status: string
        records: Array<{
          id: string
          txHash: string
          settlementId: string | null
          paymentId: string | null
          expectedAmount: number
          recipientAddress: string
          status: string
          attempts: number
          lastAttemptAt: string | null
          errorMessage: string | null
          createdAt: string
          resolvedAt: string | null
        }>
      }>('/v1/reconciliation/pending', { params }),
  },
}
