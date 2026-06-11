'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { apiFetch } from '@/lib/api'

/**
 * Shared admin pending counts.
 *
 * One poll per 30s across the entire admin section. Three consumers:
 *   1. /admin dashboard queue cards
 *   2. AdminSidebar nav badges (red dot + count per item)
 *   3. AdminLayout tab title (prepends "(N) ")
 *
 * Without the shared context, each consumer would poll independently
 * which means 3x API calls and divergent counts mid-tick. This funnels
 * to one source of truth.
 */
export interface AdminPendingCounts {
  buyerWithdrawals: number
  operatorWithdrawals: number
  compute: number
  deployments: number
}

interface AdminPendingCountsContextValue {
  counts: AdminPendingCounts
  total: number
  loading: boolean
  lastFetched: Date | null
  refresh: () => Promise<void>
}

const ZERO: AdminPendingCounts = {
  buyerWithdrawals: 0,
  operatorWithdrawals: 0,
  compute: 0,
  deployments: 0,
}

const AdminPendingCountsContext = createContext<AdminPendingCountsContextValue>({
  counts: ZERO,
  total: 0,
  loading: true,
  lastFetched: null,
  refresh: async () => {},
})

const AUTO_REFRESH_MS = 30_000

export function AdminPendingCountsProvider({ children }: { children: React.ReactNode }) {
  const [counts, setCounts] = useState<AdminPendingCounts>(ZERO)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const inflightRef = useRef(false)

  const fetchCounts = useCallback(async () => {
    if (inflightRef.current) return
    inflightRef.current = true
    try {
      const [buyerW, operatorW, compute, deploy] = await Promise.all([
        apiFetch<{ total: number }>('/v1/admin/buyer-withdrawals?status=PENDING&limit=1').catch(
          () => ({ total: 0 }),
        ),
        apiFetch<{ total: number }>('/v1/admin/withdrawals?status=PENDING&limit=1').catch(
          () => ({ total: 0 }),
        ),
        apiFetch<{ stats: { pending: number } }>('/v1/admin/compute/stats').catch(
          () => ({ stats: { pending: 0 } }),
        ),
        apiFetch<{ deployments: unknown[]; total?: number }>('/v1/admin/deployments?status=PENDING&limit=1').catch(
          () => ({ deployments: [], total: 0 }),
        ),
      ])
      setCounts({
        buyerWithdrawals: buyerW.total ?? 0,
        operatorWithdrawals: operatorW.total ?? 0,
        compute: compute.stats?.pending ?? 0,
        deployments: deploy.total ?? deploy.deployments?.length ?? 0,
      })
      setLastFetched(new Date())
    } finally {
      inflightRef.current = false
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void fetchCounts().finally(() => setLoading(false))
    const id = setInterval(() => {
      // Skip refresh when the tab is hidden — saves API roundtrips and
      // keeps per-admin queue load low when nobody's watching.
      if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
        void fetchCounts()
      }
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [fetchCounts])

  const total =
    counts.buyerWithdrawals + counts.operatorWithdrawals + counts.compute + counts.deployments

  const value = useMemo<AdminPendingCountsContextValue>(
    () => ({ counts, total, loading, lastFetched, refresh: fetchCounts }),
    [counts, total, loading, lastFetched, fetchCounts],
  )

  return (
    <AdminPendingCountsContext.Provider value={value}>
      {children}
    </AdminPendingCountsContext.Provider>
  )
}

export function useAdminPendingCounts(): AdminPendingCountsContextValue {
  return useContext(AdminPendingCountsContext)
}

/**
 * Side-effect hook: prepend "(N) " to the document title whenever the
 * total pending count is non-zero. Restores the original title on
 * unmount. Use inside the admin layout so it covers all /admin pages.
 */
export function useAdminTabTitleBadge() {
  const { total } = useAdminPendingCounts()
  useEffect(() => {
    if (typeof document === 'undefined') return
    const original = document.title.replace(/^\(\d+\)\s+/, '')
    document.title = total > 0 ? `(${total}) ${original}` : original
    return () => {
      document.title = original
    }
  }, [total])
}
