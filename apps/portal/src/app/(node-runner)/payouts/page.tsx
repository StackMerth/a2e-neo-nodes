'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Wallet, ExternalLink, CircleCheck, Clock, Loader2, CircleX, PiggyBank, ArrowDownToLine, TrendingDown, Building2 } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  DataTableCard,
  EmptyState,
  FormCard,
  FormSection,
  type DataTableColumn,
} from '@/components/dashboard/FuturisticShell'

interface Payout {
  id: string; nodeId: string; walletAddress: string; amount: number; currency: string
  status: string; periodStart: string; periodEnd: string; jobCount: number
  txHash: string | null; txConfirmed: boolean; createdAt: string; processedAt: string | null
}

interface PayoutData { payouts: Payout[]; total: number; page: number; limit: number; pages: number }

// formatRelative + SOLANA_ADDR_REGEX moved up from /payouts/settings —
// the Platform Balance card lives here now, so its withdraw flow and
// next-unlock countdown live here too.
function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `in ${days} day${days === 1 ? '' : 's'}`
}
const SOLANA_ADDR_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

interface InternalSpend {
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
}

type PayoutRow = Payout & Record<string, unknown>
type SpendRow = InternalSpend & Record<string, unknown>

const statusConfig: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
  COMPLETED: { bg: 'rgba(34,197,94,0.1)', color: 'var(--success)', icon: <CircleCheck size={12} /> },
  PENDING: { bg: 'rgba(245,158,11,0.1)', color: 'var(--warning)', icon: <Clock size={12} /> },
  PROCESSING: { bg: 'rgba(59,130,246,0.1)', color: 'var(--info)', icon: <Loader2 size={12} className="animate-spin" /> },
  FAILED: { bg: 'rgba(239,68,68,0.1)', color: 'var(--danger)', icon: <CircleX size={12} /> },
}

export default function PayoutsPage() {
  const { toast } = useToast()
  const [data, setData] = useState<PayoutData | null>(null)
  // Internal-spend ledger. Loaded in parallel with payouts so the
  // page paints once. Empty array when the operator isn't a dual-
  // role user or has never spent from balance.
  const [spends, setSpends] = useState<InternalSpend[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)

  // Platform Balance state — moved from /payouts/settings so the
  // balance + Withdraw CTA sit on the Payouts page itself. Settings
  // page now only owns mode, profile, wallet, and auto-payout prefs.
  const [available, setAvailable] = useState(0)
  const [pending, setPending] = useState(0)
  const [spent, setSpent] = useState(0)
  const [nextUnlockAt, setNextUnlockAt] = useState<string | null>(null)
  const [cooldownHours, setCooldownHours] = useState(48)
  const [savedWallet, setSavedWallet] = useState('')
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawWallet, setWithdrawWallet] = useState('')
  const [saveWallet, setSaveWallet] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  // T3.2: Stripe Connect status for the operator. Loaded in parallel
  // with the rest of the page so the Connect Bank section renders on
  // first paint.
  const [stripeConnect, setStripeConnect] = useState<{
    configured: boolean
    connected: boolean
    summary?: 'CREATED' | 'PENDING_REVIEW' | 'READY'
    payoutsEnabled?: boolean
    requirementsCurrentlyDue?: string[]
  } | null>(null)
  const [stripeOnboarding, setStripeOnboarding] = useState(false)

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    try {
      const [p, s, modeInfo, profile, connect] = await Promise.all([
        nodeRunner.payouts({ page: String(page), limit: '20' }) as Promise<PayoutData>,
        nodeRunner.internalSpends().catch(() => ({ spends: [], total: 0 })),
        nodeRunner.payoutMode().catch(() => null),
        nodeRunner.profile().catch(() => null),
        nodeRunner.stripeConnect.status().catch(() => null),
      ])
      setData(p)
      setSpends(s.spends)
      if (modeInfo) {
        setAvailable(Number(modeInfo.available ?? 0))
        setPending(Number(modeInfo.pending ?? 0))
        setSpent(Number(modeInfo.spent ?? 0))
        setNextUnlockAt(modeInfo.nextUnlockAt ?? null)
        setCooldownHours(Number(modeInfo.cooldownHours ?? 48))
      }
      if (profile) {
        setSavedWallet((profile as { walletAddress?: string }).walletAddress ?? '')
      }
      setStripeConnect(connect)
    } catch { /* ignore */ }
    finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [page])

  useEffect(() => { loadData() }, [loadData])

  function openWithdrawDialog() {
    if (available <= 0) {
      toast('error', pending > 0 ? `No unlocked balance yet. $${pending.toFixed(2)} is still in cool-down.` : 'No unpaid balance to withdraw')
      return
    }
    setWithdrawWallet(savedWallet)
    setSaveWallet(false)
    setWithdrawOpen(true)
  }

  const withdrawWalletValid = SOLANA_ADDR_REGEX.test(withdrawWallet.trim())

  async function handleWithdrawNow() {
    const trimmed = withdrawWallet.trim()
    if (!withdrawWalletValid) {
      toast('error', 'Destination wallet does not look like a Solana address')
      return
    }
    setWithdrawing(true)
    try {
      const result = await nodeRunner.withdrawNow({
        walletAddress: trimmed !== savedWallet ? trimmed : undefined,
        saveWallet: trimmed !== savedWallet && saveWallet,
      })
      const successCount = result.settlements.filter((s) => s.success).length
      const totalCount = result.settlements.length
      if (successCount === totalCount) {
        toast('success', `Withdrew $${result.totalPaid.toFixed(2)} to ${result.destinationWallet.slice(0, 6)}...${result.destinationWallet.slice(-4)}`)
      } else {
        toast('error', `Partial withdrawal: ${successCount}/${totalCount} settlements succeeded`)
      }
      setWithdrawOpen(false)
      await loadData(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Withdrawal failed'
      toast('error', msg)
    } finally {
      setWithdrawing(false)
    }
  }

  const spendColumns: Array<DataTableColumn<SpendRow>> = [
    {
      key: 'createdAt',
      header: 'Date',
      render: (s) => new Date(s.createdAt).toLocaleDateString(),
    },
    {
      key: 'rental',
      header: 'Rental',
      render: (s) =>
        s.rental ? (
          <Link
            href={`/buyer/requests/${s.computeRequestId}`}
            className="text-xs font-mono hover:opacity-80"
            style={{ color: 'var(--primary)' }}
          >
            {s.rental.gpuCount}x {s.rental.gpuTier} / {s.rental.durationDays}d
          </Link>
        ) : (
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {s.computeRequestId.slice(0, 8)}...
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {s.rental?.status ?? '—'}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Debited',
      align: 'right',
      mono: true,
      render: (s) => (
        <span style={{ color: '#ef4444' }}>-${s.amount.toFixed(2)}</span>
      ),
    },
  ]

  const columns: Array<DataTableColumn<PayoutRow>> = [
    {
      key: 'createdAt',
      header: 'Date',
      render: (p) => new Date(p.createdAt).toLocaleDateString(),
    },
    {
      key: 'periodStart',
      header: 'Period',
      render: (p) => (
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {new Date(p.periodStart).toLocaleDateString()} - {new Date(p.periodEnd).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => {
        const sc = statusConfig[p.status] ?? statusConfig.PENDING!
        return (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            style={{ background: sc.bg, color: sc.color }}
          >
            {sc.icon}
            {p.status}
          </span>
        )
      },
    },
    {
      key: 'jobCount',
      header: 'Jobs',
      align: 'right',
      mono: true,
      render: (p) => p.jobCount,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      mono: true,
      render: (p) => `$${p.amount.toFixed(2)}`,
    },
    {
      key: 'txHash',
      header: 'TX',
      align: 'right',
      render: (p) => p.txHash ? (
        <a
          href={`https://solscan.io/tx/${p.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono inline-flex items-center gap-1 hover:opacity-80"
          style={{ color: 'var(--primary)' }}
        >
          {p.txHash.slice(0, 8)}...
          <ExternalLink size={10} />
        </a>
      ) : <span className="text-xs" style={{ color: 'var(--text-muted)' }}>-</span>,
    },
  ]

  return (
    <DashboardShell
      title="Payouts"
      subtitle="Settlement and payment history"
      onRefresh={() => loadData(true)}
      refreshing={refreshing}
    >
      <div className="lg:col-span-3 space-y-6">
        {/* Platform Balance — promoted to the Payouts page (was on
            /payouts/settings). Operators see the available + pending
            split and can fire a withdrawal without leaving this page. */}
        <FormCard
          title="Platform Balance"
          description="Earnings sitting on the platform, not yet paid out to your wallet"
          icon={PiggyBank}
        >
          <FormSection>
            <div className={`grid gap-4 ${spent > 0 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
              <div
                className="rounded-md p-4"
                style={{
                  background: 'rgba(34,197,94,0.06)',
                  border: '1px solid rgba(34,197,94,0.25)',
                }}
              >
                <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--primary)' }}>
                  Available
                </p>
                <p className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  ${available.toFixed(2)}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {available > 0 ? 'Withdrawable right now.' : 'Nothing past the cool-down yet.'}
                </p>
              </div>
              <div
                className="rounded-md p-4"
                style={{
                  background: 'rgba(245,158,11,0.06)',
                  border: '1px solid rgba(245,158,11,0.25)',
                }}
              >
                <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--warning, #f59e0b)' }}>
                  Pending ({cooldownHours}h cool-down)
                </p>
                <p className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  ${pending.toFixed(2)}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {pending > 0 && nextUnlockAt
                    ? `First chunk unlocks ${formatRelative(nextUnlockAt)}.`
                    : 'No earnings in cool-down.'}
                </p>
              </div>
              {spent > 0 && (
                <div
                  className="rounded-md p-4"
                  style={{
                    background: 'rgba(59,130,246,0.06)',
                    border: '1px solid rgba(59,130,246,0.25)',
                  }}
                >
                  <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2 flex items-center gap-1" style={{ color: 'var(--info, #3b82f6)' }}>
                    <TrendingDown size={12} /> Spent on rentals
                  </p>
                  <p className="font-display text-3xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    ${spent.toFixed(2)}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Already subtracted from Available.
                  </p>
                </div>
              )}
            </div>

            {!withdrawOpen ? (
              <div className="flex justify-end mt-4">
                <Button type="button" onClick={openWithdrawDialog} disabled={available <= 0}>
                  <ArrowDownToLine size={16} className="mr-2" />
                  Withdraw ${available.toFixed(2)}
                </Button>
              </div>
            ) : (
              <div
                className="mt-4 rounded-md p-4 space-y-3"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
              >
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Send ${available.toFixed(2)} to this wallet
                  </label>
                  <input
                    type="text"
                    value={withdrawWallet}
                    onChange={(e) => setWithdrawWallet(e.target.value)}
                    placeholder="Solana wallet address"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="w-full rounded-md px-3 py-2 text-sm font-mono"
                    style={{
                      background: 'var(--bg-card)',
                      border:
                        withdrawWallet.trim() === '' || withdrawWalletValid
                          ? '1px solid var(--border-color)'
                          : '1px solid rgba(239, 68, 68, 0.5)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  {withdrawWallet.trim() !== '' && !withdrawWalletValid && (
                    <p className="text-xs mt-1" style={{ color: '#ef4444' }}>
                      That does not look like a Solana address (32-44 base58 characters).
                    </p>
                  )}
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {withdrawWallet.trim() === savedWallet
                      ? 'Using your saved payout wallet.'
                      : 'One-time destination, different from your saved wallet.'}
                  </p>
                </div>

                {withdrawWallet.trim() !== '' && withdrawWallet.trim() !== savedWallet && (
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={saveWallet}
                      onChange={(e) => setSaveWallet(e.target.checked)}
                      className="rounded"
                    />
                    Save this wallet to my profile (replaces the saved one)
                  </label>
                )}

                <div className="flex gap-2 justify-end pt-1">
                  <Button type="button" variant="ghost" onClick={() => setWithdrawOpen(false)} disabled={withdrawing}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={handleWithdrawNow} loading={withdrawing} disabled={!withdrawWalletValid}>
                    <ArrowDownToLine size={16} className="mr-2" />
                    Confirm withdrawal
                  </Button>
                </div>
              </div>
            )}

            <div
              className="mt-4 text-xs rounded-md p-3 leading-relaxed"
              style={{
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.2)',
                color: 'var(--text-muted)',
              }}
            >
              Earnings sit in cool-down for {cooldownHours} hours after they accrue, giving us a buyer-dispute window. After that, the amount moves to <span style={{ color: 'var(--primary)', fontWeight: 600 }}>Available</span> and you can withdraw at any time. Two safety nets fire even if you are on hold: the platform forces a payout when your balance exceeds $50,000, or after 180 days of inactivity.
            </div>
          </FormSection>
        </FormCard>

        {/* Internal-spend ledger. Hidden when the operator has never
            paid for a rental from their balance — common for pure
            operators who don't have a buyer hat. */}
        {spends.length > 0 && (
          <DataTableCard<SpendRow>
            title="Internal Spend"
            icon={PiggyBank}
            columns={spendColumns}
            rows={spends as SpendRow[]}
            loading={loading}
            empty={null}
          />
        )}

        {/* T3.2: Stripe Connect — opt into USD payouts to bank. Hidden
            when Stripe isn't configured server-side. Once connected, the
            operator can pick "Bank via Stripe" as their payout method on
            withdrawal requests (admin-mediated path; the instant
            withdraw-now button stays Solana-only for v1). */}
        {stripeConnect?.configured && (
          <FormCard
            title="Bank payouts via Stripe"
            description={
              !stripeConnect.connected
                ? 'Receive earnings in USD directly to your bank instead of (or alongside) USDC on Solana.'
                : stripeConnect.summary === 'READY'
                  ? 'Your bank is connected and ready to receive USD payouts.'
                  : stripeConnect.summary === 'PENDING_REVIEW'
                    ? 'Stripe is reviewing your details. Payouts unlock once verification clears.'
                    : 'Finish Stripe onboarding to enable USD payouts.'
            }
            icon={Building2}
          >
            <FormSection>
              {!stripeConnect.connected ? (
                <div className="flex flex-col gap-4">
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Stripe-hosted onboarding takes 5-10 minutes. After verification, requesting
                    a withdrawal with "Bank via Stripe" routes USD to your account; Stripe pays
                    out to your bank on its normal cadence (usually next business day).
                  </p>
                  <Button
                    onClick={async () => {
                      setStripeOnboarding(true)
                      try {
                        const { onboardingUrl } = await nodeRunner.stripeConnect.onboard()
                        window.location.assign(onboardingUrl)
                      } catch (err) {
                        toast('error', err instanceof Error ? err.message : 'Could not start Stripe onboarding')
                        setStripeOnboarding(false)
                      }
                    }}
                    loading={stripeOnboarding}
                    className="self-start"
                  >
                    <Building2 size={16} className="mr-2" />
                    Connect Stripe
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: 'var(--text-muted)' }}>Status</span>
                    <span
                      className="font-mono text-xs px-2 py-0.5 rounded"
                      style={
                        stripeConnect.summary === 'READY'
                          ? { background: 'rgba(34,197,94,0.1)', color: 'var(--success)' }
                          : { background: 'rgba(245,158,11,0.1)', color: 'var(--warning)' }
                      }
                    >
                      {stripeConnect.summary ?? 'UNKNOWN'}
                    </span>
                  </div>
                  {stripeConnect.requirementsCurrentlyDue && stripeConnect.requirementsCurrentlyDue.length > 0 && (
                    <div
                      className="text-xs rounded px-3 py-2"
                      style={{
                        background: 'rgba(245,158,11,0.08)',
                        border: '1px solid rgba(245,158,11,0.25)',
                        color: 'var(--warning)',
                      }}
                    >
                      Stripe needs: {stripeConnect.requirementsCurrentlyDue.join(', ')}
                    </div>
                  )}
                  <div className="flex gap-2">
                    {stripeConnect.summary !== 'READY' && (
                      <Button
                        onClick={async () => {
                          setStripeOnboarding(true)
                          try {
                            const { onboardingUrl } = await nodeRunner.stripeConnect.onboard()
                            window.location.assign(onboardingUrl)
                          } catch (err) {
                            toast('error', err instanceof Error ? err.message : 'Could not resume onboarding')
                            setStripeOnboarding(false)
                          }
                        }}
                        loading={stripeOnboarding}
                        variant="secondary"
                      >
                        Finish onboarding
                      </Button>
                    )}
                    <Button
                      onClick={async () => {
                        if (!confirm('Disconnect Stripe? You can reconnect later but will need to redo onboarding.')) return
                        try {
                          await nodeRunner.stripeConnect.disconnect()
                          toast('success', 'Stripe disconnected')
                          await loadData(true)
                        } catch (err) {
                          toast('error', err instanceof Error ? err.message : 'Disconnect failed')
                        }
                      }}
                      variant="ghost"
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              )}
            </FormSection>
          </FormCard>
        )}

        <DataTableCard<PayoutRow>
          title="Payout History"
          icon={Wallet}
          actions={
            <Link href="/payouts/settings">
              <Button variant="secondary" size="sm">
                <Wallet size={14} className="mr-1" />
                Payout Settings
              </Button>
            </Link>
          }
          columns={columns}
          rows={(data?.payouts ?? []) as PayoutRow[]}
          loading={loading}
          empty={
            <EmptyState
              icon={Wallet}
              title="No payouts yet"
              description="Settlement records will appear here after your first payout cycle."
            />
          }
          pagination={data ? {
            page: data.page,
            pageSize: data.limit,
            total: data.total,
            onPageChange: setPage,
          } : undefined}
        />
      </div>
    </DashboardShell>
  )
}
