// API Client for A²E Engine

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://a2e.byredstone.com'
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || 'a2e-dev-key-2026'

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

  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
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

    delete: (id: string) =>
      apiFetch<void>(`/v1/nodes/${id}`, { method: 'DELETE' }),

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
    summary: (params?: { startDate?: string; endDate?: string }) =>
      apiFetch<{
        totalEarnings: number
        totalGpuSeconds: number
        totalJobs: number
        byMarket: Record<string, { earnings: number; jobs: number }>
        byNode: Record<string, { earnings: number; jobs: number }>
      }>('/v1/earnings/summary', { params }),

    byMarket: (params?: { days?: number }) =>
      apiFetch<{
        period: { start: string; end: string }
        total: { earnings: number; gpuHours: number; jobCount: number }
        byMarket: Record<string, { earnings: number; gpuHours: number; jobCount: number }>
      }>('/v1/earnings/by-market', { params }),

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
        solanaRpcUrl: string | null
        usdcMint: string | null
      }>('/v1/settlements/config'),

    updateConfig: (data: { period?: string; minimumPayout?: number; dayOfWeek?: number }) =>
      apiFetch<Record<string, unknown>>('/v1/settlements/config', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

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
        headers: { 'X-API-Key': API_KEY },
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
        headers: { 'X-API-Key': API_KEY },
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
}
