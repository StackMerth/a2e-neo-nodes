'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sparkles, Cpu, CheckCircle2, XCircle, AlertCircle, Loader2, DollarSign, Wallet } from 'lucide-react'
import { ubi } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import {
  DashboardShell,
  DashboardMainColumn,
  DashboardRightRail,
  SectionCard,
  EmptyState,
  MetricTriad,
  type MetricCardData,
} from '@/components/dashboard/FuturisticShell'

interface OptInRow {
  id: string
  protocol: string
  consentVersion: string
  optedInAt: string
}

interface NodeRow {
  id: string
  walletAddress: string
  gpuTier: string
  status: string
  ubiOptIns: OptInRow[]
}

type StatusResponse = Awaited<ReturnType<typeof ubi.status>>

export default function UbiPage() {
  const [data, setData] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [consentDialogNodeId, setConsentDialogNodeId] = useState<string | null>(null)
  const [consentText, setConsentText] = useState<{
    protocol: string
    version: string
    text: string
  } | null>(null)
  const [consentLoading, setConsentLoading] = useState(false)
  const [actingNodeId, setActingNodeId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await ubi.status()
      setData(res)
    } catch (err) {
      setActionMessage(`Status fetch failed: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openConsentDialog = useCallback(async (nodeId: string) => {
    setConsentDialogNodeId(nodeId)
    setConsentLoading(true)
    try {
      const res = await ubi.consentCurrent('BOUNDLESS')
      setConsentText({ protocol: res.protocol, version: res.version, text: res.text })
    } catch (err) {
      setActionMessage(`Consent fetch failed: ${(err as Error).message}`)
      setConsentDialogNodeId(null)
    } finally {
      setConsentLoading(false)
    }
  }, [])

  const confirmOptIn = useCallback(async () => {
    if (!consentDialogNodeId || !consentText) return
    setActingNodeId(consentDialogNodeId)
    try {
      const res = await ubi.optIn({
        nodeId: consentDialogNodeId,
        protocol: consentText.protocol,
        consentVersion: consentText.version,
      })
      setActionMessage(
        res.created
          ? `Opted in. Earnings will start accruing when the broker dispatches work.`
          : `Already opted in.`,
      )
      setConsentDialogNodeId(null)
      setConsentText(null)
      await refresh()
    } catch (err) {
      setActionMessage(`Opt-in failed: ${(err as Error).message}`)
    } finally {
      setActingNodeId(null)
    }
  }, [consentDialogNodeId, consentText, refresh])

  const optOut = useCallback(
    async (nodeId: string, protocol: string) => {
      setActingNodeId(nodeId)
      try {
        const res = await ubi.optOut({ nodeId, protocol })
        setActionMessage(`Opted out (${res.optedOutCount} active rows flipped)`)
        await refresh()
      } catch (err) {
        setActionMessage(`Opt-out failed: ${(err as Error).message}`)
      } finally {
        setActingNodeId(null)
      }
    },
    [refresh],
  )

  const totals = data?.totals ?? { accruedUsd: 0, paidUsd: 0 }
  const optedInCount =
    data?.nodes.reduce((sum, n) => sum + (n.ubiOptIns.length > 0 ? 1 : 0), 0) ?? 0
  const totalNodes = data?.nodes.length ?? 0

  const metrics: MetricCardData[] = [
    {
      label: 'Accrued (USD)',
      value: `$${totals.accruedUsd.toFixed(2)}`,
      detail: 'Pending withdraw',
      icon: DollarSign,
      tone: 'green',
    },
    {
      label: 'Paid (USD)',
      value: `$${totals.paidUsd.toFixed(2)}`,
      detail: 'Already withdrawn',
      icon: Wallet,
      tone: 'blue',
    },
    {
      label: 'Opted-in nodes',
      value: `${optedInCount} / ${totalNodes}`,
      detail: 'ZK-UBI is per-node',
      icon: Cpu,
      tone: 'purple',
    },
  ]

  return (
    <DashboardShell
      title="ZK-UBI"
      subtitle="Earn from cryptographic proof work on Boundless when your node is idle"
      onRefresh={refresh}
      refreshing={loading}
    >
      <DashboardMainColumn>
        <SectionCard title="Overview" icon={Sparkles}>
          <MetricTriad metrics={metrics} />
          {actionMessage && (
            <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-200">
              {actionMessage}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Your nodes" icon={Cpu}>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="size-4 animate-spin" />
              Loading nodes...
            </div>
          ) : !data?.nodes.length ? (
            <EmptyState
              icon={Cpu}
              title="No nodes yet"
              description="Add a node from the Nodes page first, then come back to opt it into ZK-UBI."
            />
          ) : (
            <div className="space-y-3">
              {data.nodes.map((node) => (
                <NodeRowCard
                  key={node.id}
                  node={node}
                  onOptIn={() => openConsentDialog(node.id)}
                  onOptOut={(protocol) => optOut(node.id, protocol)}
                  acting={actingNodeId === node.id}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </DashboardMainColumn>

      <DashboardRightRail>
        <SectionCard title="Recent earnings" icon={AlertCircle}>
          {!data?.recentEarnings.length ? (
            <EmptyState
              icon={AlertCircle}
              title="No earnings yet"
              description="Once you opt in and the broker dispatches work, accepted proofs will roll up here every ~48 hours."
            />
          ) : (
            <div className="space-y-2">
              {data.recentEarnings.map((row) => (
                <div
                  key={row.id}
                  className="rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--border-color)' }}
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                      {row.nodeId.slice(0, 12)}...
                    </span>
                    <span className="font-semibold text-emerald-400">
                      ${row.operatorUsd.toFixed(4)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>{new Date(row.periodEnd).toLocaleDateString()}</span>
                    <span
                      className={
                        row.status === 'PAID'
                          ? 'rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-300'
                          : 'rounded bg-amber-500/10 px-2 py-0.5 text-amber-300'
                      }
                    >
                      {row.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </DashboardRightRail>

      {consentDialogNodeId && (
        <ConsentDialog
          consentText={consentText}
          loading={consentLoading}
          submitting={actingNodeId === consentDialogNodeId}
          onCancel={() => {
            setConsentDialogNodeId(null)
            setConsentText(null)
          }}
          onConfirm={confirmOptIn}
        />
      )}
    </DashboardShell>
  )
}

function NodeRowCard({
  node,
  onOptIn,
  onOptOut,
  acting,
}: {
  node: NodeRow
  onOptIn: () => void
  onOptOut: (protocol: string) => void
  acting: boolean
}) {
  const activeOptIns = node.ubiOptIns
  const isOptedIn = activeOptIns.length > 0

  return (
    <div
      className="flex items-center justify-between rounded-lg border px-4 py-3"
      style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}
    >
      <div className="flex items-center gap-3">
        <div
          className={
            isOptedIn
              ? 'flex size-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300'
              : 'flex size-9 items-center justify-center rounded-full bg-zinc-800/50 text-zinc-400'
          }
        >
          {isOptedIn ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />}
        </div>
        <div>
          <div className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
            {node.id.slice(0, 18)}...
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {node.gpuTier} · {node.status}
            {isOptedIn && (
              <>
                {' '}
                · Opted into {activeOptIns.map((o) => o.protocol).join(', ')}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        {isOptedIn ? (
          activeOptIns.map((optIn) => (
            <Button
              key={optIn.id}
              variant="secondary"
              size="sm"
              disabled={acting}
              onClick={() => onOptOut(optIn.protocol)}
            >
              {acting ? 'Working...' : `Opt out of ${optIn.protocol}`}
            </Button>
          ))
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={acting}
            onClick={onOptIn}
          >
            {acting ? 'Working...' : 'Opt in to Boundless'}
          </Button>
        )}
      </div>
    </div>
  )
}

function ConsentDialog({
  consentText,
  loading,
  submitting,
  onCancel,
  onConfirm,
}: {
  consentText: { protocol: string; version: string; text: string } | null
  loading: boolean
  submitting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-lg border"
        style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
      >
        <div className="border-b px-6 py-4" style={{ borderColor: 'var(--border-color)' }}>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Disclosure: ZK-UBI on {consentText?.protocol ?? 'Boundless'}
          </h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Version: <span className="font-mono">{consentText?.version ?? 'loading'}</span>
          </p>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
          {loading || !consentText ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="size-4 animate-spin" />
              Loading disclosure...
            </div>
          ) : (
            <pre className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {consentText.text}
            </pre>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-4" style={{ borderColor: 'var(--border-color)' }}>
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={submitting || loading}>
            {submitting ? 'Accepting...' : 'Accept and opt in'}
          </Button>
        </div>
      </div>
    </div>
  )
}
