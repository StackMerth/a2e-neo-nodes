'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Server, CircleCheck, Hash, Layers, Calendar, FileText, Wallet, Receipt, Globe, KeyRound, PiggyBank, CreditCard, Cpu, Workflow, Sparkles, Zap, Save, Copy } from 'lucide-react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { buyer } from '@/lib/api'
import { useUsdcPayment } from '@/hooks/useUsdcPayment'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

interface GpuTier {
  id: string
  name: string
  dailyRate: number
  // C2 wave 2: consumer-class GPUs are inference-only. When the buyer
  // picks TRAINING or MIXED, these cards grey out with an explanatory
  // tooltip and become non-selectable.
  inferenceOnly?: boolean
}

const GPU_TIERS: GpuTier[] = [
  { id: 'H100', name: 'H100', dailyRate: 5.84 },
  { id: 'H200', name: 'H200', dailyRate: 7.49 },
  { id: 'B200', name: 'B200', dailyRate: 13.38 },
  { id: 'B300', name: 'B300', dailyRate: 17.99 },
  { id: 'GB300', name: 'GB300', dailyRate: 20.81 },
  // L40S: NVIDIA Ada-Lovelace datacenter card. $21/day = $0.88/hr retail.
  { id: 'L40S', name: 'L40S', dailyRate: 0.88 },
  // C2 wave 2: consumer / prosumer tiers. Lower price, inference-only.
  { id: 'RTX_4090', name: 'RTX 4090', dailyRate: 0.58, inferenceOnly: true },
  { id: 'RTX_3090', name: 'RTX 3090', dailyRate: 0.37, inferenceOnly: true },
  { id: 'CONSUMER', name: 'Consumer', dailyRate: 0.29, inferenceOnly: true },
]

const HOURLY_RATES: Record<string, number> = {
  H100: 5.84,
  H200: 7.49,
  // L40S: $21/day = $0.875/hr retail.
  L40S: 21 / 24,
  B200: 13.38,
  B300: 17.99,
  GB300: 20.81,
  // C2 wave 2: GPU_TIER_CONFIG retailRate / 24
  RTX_4090: 14 / 24,
  RTX_3090: 9 / 24,
  CONSUMER: 7 / 24,
}

const CONSUMER_TIER_IDS = new Set(['CONSUMER', 'RTX_4090', 'RTX_3090'])

// M6: lightweight client-side validation for the buyer's SSH public key.
// Matches the canonical openssh public key formats: ssh-rsa, ssh-ed25519,
// ssh-dss, and the three ecdsa-sha2-nistp* variants, optionally followed
// by a comment. The API runs the authoritative validation; this is just
// to catch obvious paste mistakes before submit.
const SSH_PUBKEY_REGEX =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(\s+.+)?$/

const TIER_STYLES: Record<string, { border: string; bg: string; text: string; glow: string; ring: string }> = {
  H100: {
    border: 'rgba(34,197,94,0.4)',
    bg: 'rgba(34,197,94,0.05)',
    text: 'var(--success)',
    glow: '0 0 20px rgba(34,197,94,0.1)',
    ring: 'rgba(34,197,94,0.5)',
  },
  H200: {
    border: 'rgba(59,130,246,0.4)',
    bg: 'rgba(59,130,246,0.05)',
    text: 'var(--info)',
    glow: '0 0 20px rgba(59,130,246,0.1)',
    ring: 'rgba(59,130,246,0.5)',
  },
  B200: {
    border: 'rgba(139,92,246,0.4)',
    bg: 'rgba(139,92,246,0.05)',
    text: '#8b5cf6',
    glow: '0 0 20px rgba(139,92,246,0.1)',
    ring: 'rgba(139,92,246,0.5)',
  },
  B300: {
    border: 'rgba(245,158,11,0.4)',
    bg: 'rgba(245,158,11,0.05)',
    text: 'var(--warning)',
    glow: '0 0 20px rgba(245,158,11,0.1)',
    ring: 'rgba(245,158,11,0.5)',
  },
  GB300: {
    border: 'rgba(239,68,68,0.4)',
    bg: 'rgba(239,68,68,0.05)',
    text: 'var(--danger)',
    glow: '0 0 20px rgba(239,68,68,0.1)',
    ring: 'rgba(239,68,68,0.5)',
  },
  // L40S: cyan accent — distinct from datacenter purples/reds and from
  // the consumer-tier teal cluster below.
  L40S: {
    border: 'rgba(6,182,212,0.4)',
    bg: 'rgba(6,182,212,0.05)',
    text: '#06b6d4',
    glow: '0 0 20px rgba(6,182,212,0.1)',
    ring: 'rgba(6,182,212,0.5)',
  },
  // C2 wave 2: consumer tiers share a single teal palette so they read
  // as a distinct "edge" cluster instead of competing with datacenter
  // hues. Slightly lower saturation than the datacenter accents.
  RTX_4090: {
    border: 'rgba(20,184,166,0.4)',
    bg: 'rgba(20,184,166,0.05)',
    text: '#14b8a6',
    glow: '0 0 20px rgba(20,184,166,0.1)',
    ring: 'rgba(20,184,166,0.5)',
  },
  RTX_3090: {
    border: 'rgba(20,184,166,0.35)',
    bg: 'rgba(20,184,166,0.04)',
    text: '#14b8a6',
    glow: '0 0 18px rgba(20,184,166,0.08)',
    ring: 'rgba(20,184,166,0.4)',
  },
  CONSUMER: {
    border: 'rgba(20,184,166,0.3)',
    bg: 'rgba(20,184,166,0.03)',
    text: '#14b8a6',
    glow: '0 0 16px rgba(20,184,166,0.06)',
    ring: 'rgba(20,184,166,0.35)',
  },
}

// C2 wave 2: workload-type picker. Matches the WorkloadType prisma
// enum and the buyer-compute zod refine. INFERENCE unlocks the
// consumer tier cards; TRAINING / MIXED hard-filters them out.
type WorkloadType = 'INFERENCE' | 'TRAINING' | 'MIXED'
const WORKLOAD_OPTIONS: Array<{
  id: WorkloadType
  label: string
  pitch: string
  caveat: string
  icon: typeof Cpu
  accent: string
}> = [
  {
    id: 'INFERENCE',
    label: 'Inference',
    pitch: 'Short-burst predictions. Consumer GPUs available at edge prices.',
    caveat: 'Best for chat, embeddings, image generation, batch scoring.',
    icon: Sparkles,
    accent: '#14b8a6',
  },
  {
    id: 'TRAINING',
    label: 'Training',
    pitch: 'Long-running model training. Data-center GPUs only.',
    caveat: 'Multi-day runs, full datasets, fine-tunes. No consumer hardware.',
    icon: Workflow,
    accent: '#3b82f6',
  },
  {
    id: 'MIXED',
    label: 'Mixed',
    pitch: 'Both — data-center GPUs to play it safe.',
    caveat: 'Default. Skips consumer tiers; you stay on enterprise inventory.',
    icon: Cpu,
    accent: '#a78bfa',
  },
]

// M2: short durations live alongside the longer enterprise commitments.
// 1d / 3d cover quick experiments where per-minute billing matters most;
// 7d-90d are the longer commitments. 'Custom' input handles anything in
// between (1-365 days, matching the API cap).
const DURATION_OPTIONS = [1, 3, 7, 14, 30, 60, 90]

// M3 pricing tier metadata. Discounts mirror SPOT_DISCOUNT_PCT and
// RESERVED_DISCOUNT_PCT defaults on the API; if those env vars change,
// update the UI labels here too. The 'preemptible' / 'commitment'
// copy explains the trade-off so buyers understand the discount.
type RentalTier = 'ON_DEMAND' | 'SPOT' | 'RESERVED'
const TIER_OPTIONS: Array<{
  id: RentalTier
  label: string
  discount: number
  multiplier: number
  pitch: string
  caveat: string
}> = [
  { id: 'ON_DEMAND', label: 'On-Demand', discount: 0,    multiplier: 1.0, pitch: 'Full price, no commitment', caveat: 'Highest reliability, never preempted' },
  { id: 'SPOT',      label: 'Spot',      discount: 0.4,  multiplier: 0.6, pitch: '40% off',                  caveat: 'Preemptible with 90s notice when On-Demand demand spikes' },
  { id: 'RESERVED',  label: 'Reserved',  discount: 0.1,  multiplier: 0.9, pitch: '10% off + lock in capacity', caveat: 'Pick a 7/30/90-day commitment. Non-refundable on early terminate.' },
]

const COMMITMENT_OPTIONS = [7, 30, 90] as const

// M4.4: region options for the Region selector. Empty string = "Any"
// (default), allocator skips the region filter entirely. Values match
// the strings operators put on Node.region.
const REGION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',            label: 'Any region' },
  { value: 'us-east-1',   label: 'US East (Virginia)' },
  { value: 'us-west-2',   label: 'US West (Oregon)' },
  { value: 'eu-west-1',   label: 'EU West (Ireland)' },
  { value: 'ap-south-1',  label: 'APAC (Mumbai)' },
]

export default function RequestComputePage() {
  const router = useRouter()
  const { toast } = useToast()
  const [selectedTier, setSelectedTier] = useState<string | null>(null)
  // M5.10c: optional preferred-operator slug. Set from URL when the
  // buyer arrives via "Rent from this operator" on the marketplace.
  // Buyer can dismiss the chip; submission body sends the slug only
  // if still present.
  const [preferredOperatorSlug, setPreferredOperatorSlug] = useState<string | null>(null)

  // M5.10b: when the buyer arrives from the marketplace /rent page,
  // the URL carries ?gpuTier=H100 so the form lands with that tier
  // pre-selected. Only honor known tier codes.
  // M5.10c: also reads ?operator=<slug> for the soft operator
  // preference. Slug validated server-side at submit time.
  const searchParams = useSearchParams()
  useEffect(() => {
    const tierFromQuery = searchParams?.get('gpuTier')
    if (tierFromQuery && GPU_TIERS.some(t => t.id === tierFromQuery)) {
      setSelectedTier(tierFromQuery)
      // C2 wave 2: consumer-tier deep links land with workloadType=
      // INFERENCE so the tier card renders as selected (not locked).
      // Without this, a buyer arriving from a marketplace "Rent →"
      // on RTX_4090 would see the card greyed out and have to flip
      // the workload picker themselves.
      if (CONSUMER_TIER_IDS.has(tierFromQuery)) {
        setWorkloadType('INFERENCE')
      }
    }
    // C2 wave 2: explicit workloadType param (sent by the marketplace
    // rent-modal handoff). Overrides the consumer-tier auto-flip above
    // for the rare case where someone passes both.
    const wlFromQuery = searchParams?.get('workloadType')
    if (wlFromQuery === 'INFERENCE' || wlFromQuery === 'TRAINING' || wlFromQuery === 'MIXED') {
      setWorkloadType(wlFromQuery)
    }
    const opFromQuery = searchParams?.get('operator')
    if (opFromQuery && /^[a-z0-9-]{1,120}$/.test(opFromQuery)) {
      setPreferredOperatorSlug(opFromQuery)
    }
    // Run once on mount; ignore subsequent searchParams changes so a
    // user clicking around the form doesn't get reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [gpuCount, setGpuCount] = useState(1)
  const [duration, setDuration] = useState(30)
  const [purpose, setPurpose] = useState('')
  const [sshPubKey, setSshPubKey] = useState('')
  const [txHash, setTxHash] = useState('')
  // Wallet sign-to-pay support. When a wallet is connected and the
  // buyer picks USDC, the Submit Request button signs a USDC transfer
  // in the wallet first, then submits the rental with the resulting
  // on-chain signature as the txHash. Existing paste flow remains
  // available via the "Send from another wallet (manual paste)" toggle.
  const { publicKey, wallet } = useWallet()
  const { setVisible: openWalletModal } = useWalletModal()
  const { pay: walletPay } = useUsdcPayment()
  const [topupDestination, setTopupDestination] = useState<{ wallet: string | null; configured: boolean; network: string } | null>(null)
  const [showManualPaste, setShowManualPaste] = useState(false)
  const [walletPhase, setWalletPhase] = useState<'idle' | 'signing' | 'submitting'>('idle')
  useEffect(() => {
    buyer.balance.topupDestination()
      .then((r) => setTopupDestination({ wallet: r.wallet, configured: r.configured, network: r.network }))
      .catch(() => { /* fail silently; the paste fallback still works */ })
  }, [])
  const [submitting, setSubmitting] = useState(false)
  // C2 wave 2: workload type — MIXED is the API default and matches
  // pre-migration semantics (data-center only). If the buyer picks a
  // consumer tier without flipping to INFERENCE we'll auto-correct on
  // selection so they don't have to scroll back up.
  const [workloadType, setWorkloadType] = useState<WorkloadType>('MIXED')

  // Payment source picker:
  //   USDC             — fresh on-chain Solana transfer (always available)
  //   INTERNAL_BALANCE — operator-earned credit (dual-role users only)
  //   BUYER_BALANCE    — pre-loaded buyer credit (any buyer who topped up)
  // Picker auto-hides when neither balance route is usable, defaulting
  // straight back to the legacy USDC-only flow.
  const [paymentSource, setPaymentSource] = useState<'USDC' | 'INTERNAL_BALANCE' | 'BUYER_BALANCE'>('USDC')
  const [internalEligible, setInternalEligible] = useState(false)
  const [internalAvailable, setInternalAvailable] = useState(0)
  const [buyerBalanceUsd, setBuyerBalanceUsd] = useState<number>(0)
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      buyer.internalBalance().catch(() => null),
      buyer.balance.get().catch(() => null),
    ]).then(([internal, balance]) => {
      if (cancelled) return
      if (internal) {
        setInternalEligible(internal.eligible)
        setInternalAvailable(internal.available)
      }
      if (balance) {
        setBuyerBalanceUsd(balance.balanceUsd)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])
  // M3: pricing tier + commitment slider for RESERVED
  const [rentalTier, setRentalTier] = useState<RentalTier>('ON_DEMAND')
  const [commitmentDays, setCommitmentDays] = useState<number>(30)
  // M4.4: optional region constraint. Empty string = "Any" (default)
  // which the API normalizes to null so the allocator skips the filter.
  const [requiredRegion, setRequiredRegion] = useState<string>('')

  // Checkpoint Workspace restore: list of the buyer's past rentals that
  // have a READY checkpoint, plus the buyer's current pick. Empty string
  // = "Start fresh" (default). Fetched once on mount; rare enough that
  // we don't refetch on tier/duration changes.
  type RestoreOption = {
    checkpointId: string
    sourceRequestId: string
    gpuTier: string
    checkpointReadyAt: string | null
    requestedAt: string
  }
  const [restoreOptions, setRestoreOptions] = useState<RestoreOption[]>([])
  const [restoreCheckpointId, setRestoreCheckpointId] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    buyer.requests({ limit: '50' })
      .then((r) => {
        if (cancelled) return
        // Narrow the response shape locally — the underlying endpoint
        // returns full ComputeRequest rows.
        const rows = (r as { requests?: Array<{
          id: string
          gpuTier: string
          lastCheckpointId: string | null
          checkpointStatus: string
          checkpointReadyAt: string | null
          requestedAt: string
        }> }).requests ?? []
        const ready = rows
          .filter(row => row.checkpointStatus === 'READY' && row.lastCheckpointId)
          .map(row => ({
            checkpointId: row.lastCheckpointId as string,
            sourceRequestId: row.id,
            gpuTier: row.gpuTier,
            checkpointReadyAt: row.checkpointReadyAt,
            requestedAt: row.requestedAt,
          }))
        setRestoreOptions(ready)
      })
      .catch(() => { /* if list fails, restore picker just stays empty */ })
    return () => { cancelled = true }
  }, [])

  const hourlyRate = selectedTier ? HOURLY_RATES[selectedTier] ?? 0 : 0
  const tierMultiplier = TIER_OPTIONS.find(t => t.id === rentalTier)?.multiplier ?? 1
  const dailyRate = hourlyRate * 24 * tierMultiplier
  // RESERVED rentals always lock in commitmentDays as the duration,
  // the API enforces this server-side, the UI just mirrors it for the
  // cost preview.
  const effectiveDuration = rentalTier === 'RESERVED' ? commitmentDays : duration
  const totalCost = dailyRate * gpuCount * effectiveDuration

  // True iff the buyer is going to pay USDC by signing in their wallet
  // rather than pasting a hash. Drives the Submit button label and
  // makes handleSubmit do the wallet sign-and-pay before posting the
  // rental creation.
  const walletConnected = !!publicKey
  const walletPaySelected =
    paymentSource === 'USDC' && walletConnected && !showManualPaste

  async function handleSubmit() {
    if (!selectedTier) {
      toast('error', 'Please select a GPU tier')
      return
    }
    // USDC validation: paste-mode requires a typed hash; wallet-pay
    // mode requires the destination + connected wallet + that the
    // user has clicked through the wallet prompt.
    if (paymentSource === 'USDC') {
      if (walletPaySelected) {
        if (!topupDestination?.configured || !topupDestination.wallet) {
          toast('error', 'Topup destination not configured. Use manual paste or contact support.')
          return
        }
      } else if (!txHash.trim()) {
        toast('error', 'Enter your Solana transaction hash, or connect a wallet to sign automatically')
        return
      }
    }
    if (paymentSource === 'INTERNAL_BALANCE' && internalAvailable < totalCost) {
      toast('error', `Insufficient operator balance: need $${totalCost.toFixed(2)}, have $${internalAvailable.toFixed(2)}`)
      return
    }
    if (paymentSource === 'BUYER_BALANCE' && buyerBalanceUsd < totalCost) {
      toast('error', `Insufficient buyer balance: need $${totalCost.toFixed(2)}, have $${buyerBalanceUsd.toFixed(2)}. Top up at /buyer/balance.`)
      return
    }
    const trimmedPubKey = sshPubKey.trim()
    if (!trimmedPubKey) {
      toast('error', 'Paste your SSH public key so the operator can authorize your connection')
      return
    }
    if (!SSH_PUBKEY_REGEX.test(trimmedPubKey)) {
      toast('error', 'SSH key does not look right. It should start with ssh-rsa, ssh-ed25519, or ecdsa-sha2-...')
      return
    }

    setSubmitting(true)

    // Wallet sign-and-pay path: sign a USDC transfer in the wallet
    // first, take the signature as the txHash, then submit the rental.
    // Any throw (user rejection, insufficient balance, RPC fail) bails
    // before we touch the rental endpoint so a failed pay never leaves
    // an orphan PENDING request behind.
    let resolvedTxHash = paymentSource === 'USDC' ? txHash.trim() : undefined
    if (walletPaySelected) {
      try {
        setWalletPhase('signing')
        const { signature } = await walletPay({
          recipient: topupDestination!.wallet!,
          amountUsd: totalCost,
        })
        resolvedTxHash = signature
        setWalletPhase('submitting')
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Wallet payment failed'
        if (msg.toLowerCase().includes('user rejected')) {
          toast('error', 'Cancelled in your wallet.')
        } else {
          toast('error', msg)
        }
        setWalletPhase('idle')
        setSubmitting(false)
        return
      }
    }

    try {
      const result = await buyer.requestCompute({
        gpuTier: selectedTier,
        gpuCount,
        durationDays: effectiveDuration,
        purpose: purpose.trim() || undefined,
        paymentSource,
        // Only attach txHash when paying with USDC. INTERNAL_BALANCE /
        // BUYER_BALANCE omit it so the server-side schema's
        // conditional validation does not 400.
        txHash: paymentSource === 'USDC' ? resolvedTxHash : undefined,
        tier: rentalTier,
        commitmentDays: rentalTier === 'RESERVED' ? commitmentDays : undefined,
        requiredRegion: requiredRegion || null,
        preferredOperatorSlug: preferredOperatorSlug || null,
        sshPubKey: trimmedPubKey,
        workloadType,
        // Checkpoint Workspace restore: empty string = "Start fresh".
        restoreCheckpointId: restoreCheckpointId || null,
      }) as { id: string }
      toast('success', 'Compute request submitted successfully')
      router.push(`/buyer/requests/${result.id}`)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit compute request')
    } finally {
      setSubmitting(false)
      setWalletPhase('idle')
    }
  }

  // Insufficient-balance flags drive the Submit button + a subtle
  // warning under the picker. Recomputed on every render — cheap.
  const internalShort = paymentSource === 'INTERNAL_BALANCE' && internalAvailable < totalCost
  const buyerBalanceShort = paymentSource === 'BUYER_BALANCE' && buyerBalanceUsd < totalCost
  // Show the payment-method picker when at least one balance route is
  // usable (either dual-role operator OR buyer with topped-up credit).
  // Pure first-time buyers with $0 balance fall through to the legacy
  // USDC-only flow and never see the picker.
  const showPaymentPicker = internalEligible || buyerBalanceUsd > 0

  return (
    <DashboardShell
      title="Request Compute"
      subtitle="Select your GPU tier, quantity, and rental duration"
    >
      <div className="lg:col-span-3 w-full space-y-6">
        {/* M5.10c: preferred-operator pill. Shows when the buyer
            arrived from "Rent from this operator" on the marketplace.
            Soft preference - the allocator falls back to the general
            pool if this operator has no idle capacity at allocation
            time. Buyer can dismiss to drop the preference. */}
        {preferredOperatorSlug && (
          <div
            className="rounded-lg p-3 flex items-center gap-3 flex-wrap"
            style={{
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.30)',
            }}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--primary)' }}>
              Preferred operator
            </span>
            <span className="font-mono text-xs px-2 py-0.5 rounded-sm" style={{
              color: 'var(--text-primary)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border-color)',
            }}>
              {preferredOperatorSlug}
            </span>
            <p className="text-xs flex-1 min-w-[200px]" style={{ color: 'var(--text-secondary)' }}>
              Allocator will try this operator first. Falls back to the rest of the network if they have no idle capacity.
            </p>
            <button
              type="button"
              onClick={() => setPreferredOperatorSlug(null)}
              className="text-xs font-mono px-2 py-1 rounded-sm hover:opacity-80 transition-opacity"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}
            >
              Remove
            </button>
          </div>
        )}

        {/* C2 wave 2: Workload Type picker. Comes before GPU Tier
            because it gates which tiers are clickable below. */}
        <FormCard
          title="Workload Type"
          description="What are you running? This decides which GPU classes are eligible."
          icon={Workflow}
        >
          <FormSection>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {WORKLOAD_OPTIONS.map(w => {
                const isSelected = workloadType === w.id
                const Icon = w.icon
                return (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => {
                      setWorkloadType(w.id)
                      // If switching away from INFERENCE while a consumer
                      // tier is selected, clear the selection so the
                      // buyer doesn't unknowingly submit an invalid combo.
                      if (w.id !== 'INFERENCE' && selectedTier && CONSUMER_TIER_IDS.has(selectedTier)) {
                        setSelectedTier(null)
                      }
                    }}
                    className="text-left rounded-xl p-4 transition-all duration-200"
                    style={isSelected
                      ? { background: `${w.accent}15`, border: `1px solid ${w.accent}66`, boxShadow: `0 0 16px ${w.accent}22` }
                      : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                    }
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{w.label}</span>
                      <Icon size={16} style={{ color: w.accent }} />
                    </div>
                    <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>{w.pitch}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{w.caveat}</p>
                  </button>
                )
              })}
            </div>
          </FormSection>
        </FormCard>

        {/* GPU Tier */}
        <FormCard
          title="GPU Tier"
          description={workloadType === 'INFERENCE'
            ? 'Pick the GPU class you need. Consumer tiers unlocked for inference.'
            : 'Pick the GPU class you need. Switch workload to Inference to unlock consumer GPUs.'}
          icon={Server}
        >
          <FormSection>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {GPU_TIERS.map(t => {
                const isSelected = selectedTier === t.id
                const ts = TIER_STYLES[t.id]!
                const hr = HOURLY_RATES[t.id] ?? 0
                const dr = hr * 24
                // C2 wave 2: gate consumer tiers behind workload=INFERENCE.
                const isLocked = !!t.inferenceOnly && workloadType !== 'INFERENCE'
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      if (isLocked) return
                      setSelectedTier(t.id)
                    }}
                    disabled={isLocked}
                    title={isLocked ? 'Inference workload only. Switch the workload type above to unlock.' : undefined}
                    className="relative text-left rounded-xl p-4 transition-all duration-200"
                    style={isLocked
                      ? {
                          border: '1px dashed var(--border-color)',
                          background: 'var(--bg-elevated)',
                          opacity: 0.45,
                          cursor: 'not-allowed',
                        }
                      : isSelected
                      ? {
                          border: `1px solid ${ts.border}`,
                          background: ts.bg,
                          boxShadow: `${ts.glow}, 0 0 0 1px ${ts.ring}`,
                        }
                      : {
                          border: '1px solid var(--border-color)',
                          background: 'var(--bg-elevated)',
                        }
                    }
                  >
                    {/* Datacenter tiers get the classic checkmark on
                        selection. Consumer tiers carry the INFERENCE
                        badge in that same corner — the teal selection
                        ring alone is enough signal there, so we drop
                        the checkmark to avoid the icons overlapping. */}
                    {isSelected && !isLocked && !t.inferenceOnly && (
                      <div className="absolute top-3 right-3">
                        <CircleCheck size={18} style={{ color: ts.text }} />
                      </div>
                    )}
                    {t.inferenceOnly && !isLocked && (
                      <div
                        className="absolute top-2 right-2 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm"
                        style={{ color: ts.text, background: 'rgba(20,184,166,0.12)' }}
                      >
                        Inference
                      </div>
                    )}
                    <div
                      className="text-lg font-bold mb-1"
                      style={{ color: isLocked ? 'var(--text-muted)' : isSelected ? ts.text : 'var(--text-primary)' }}
                    >
                      {t.name}
                    </div>
                    <div className="space-y-1 text-sm mt-2">
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--text-muted)' }}>Hourly</span>
                        <span className="font-medium font-mono text-xs" style={{ color: 'var(--primary)' }}>${hr.toFixed(2)}/hr</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--text-muted)' }}>Daily</span>
                        <span className="font-medium font-mono text-xs" style={{ color: 'var(--primary)' }}>${dr.toFixed(2)}/day</span>
                      </div>
                    </div>
                    {isLocked && (
                      <p className="text-[10px] mt-2 italic" style={{ color: 'var(--text-muted)' }}>
                        Inference workload only
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </FormSection>
        </FormCard>

        {/* Pricing Tier */}
        <FormCard
          title="Pricing Tier"
          description="On-Demand for reliability, Spot for 40% off, Reserved for locked-in capacity."
          icon={Layers}
        >
          <FormSection>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {TIER_OPTIONS.map(t => {
                const isSelected = rentalTier === t.id
                const accent = t.id === 'SPOT' ? '#f59e0b' : t.id === 'RESERVED' ? '#3b82f6' : '#22c55e'
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setRentalTier(t.id)}
                    className="text-left rounded-xl p-4 transition-all duration-200"
                    style={isSelected
                      ? { background: `${accent}15`, border: `1px solid ${accent}66`, boxShadow: `0 0 16px ${accent}22` }
                      : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                    }
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t.label}</span>
                      {t.discount > 0 && (
                        <span
                          className="text-xs font-bold px-2 py-0.5 rounded"
                          style={{ background: `${accent}33`, color: accent }}
                        >
                          -{Math.round(t.discount * 100)}%
                        </span>
                      )}
                    </div>
                    <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>{t.pitch}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t.caveat}</p>
                  </button>
                )
              })}
            </div>

            {/* RESERVED commitment slider, only shown when RESERVED is picked */}
            {rentalTier === 'RESERVED' && (
              <div className="p-4 rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}>
                <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Commitment Period</h3>
                <div className="flex gap-3 flex-wrap">
                  {COMMITMENT_OPTIONS.map(d => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setCommitmentDays(d)}
                      className="px-4 h-11 rounded-lg font-medium transition-all duration-200"
                      style={commitmentDays === d
                        ? { background: '#3b82f6', color: '#fff' }
                        : { background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
                      }
                    >
                      {d}d
                    </button>
                  ))}
                </div>
                <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
                  Locked-in capacity for {commitmentDays} days. Non-refundable on early terminate.
                </p>
              </div>
            )}
          </FormSection>
        </FormCard>

        {/* GPU Count + Duration */}
        <FormCard
          title="Quantity and Duration"
          description="How many GPUs and how long do you need them?"
          icon={Calendar}
        >
          <FormSection title="Number of GPUs">
            <div className="flex gap-3 flex-wrap items-center">
              {[1, 2, 4, 8].map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setGpuCount(n)}
                  className="w-14 h-14 rounded-xl font-bold text-lg transition-all duration-200"
                  style={gpuCount === n
                    ? { background: 'var(--primary)', color: '#fff', boxShadow: '0 0 10px rgba(34,197,94,0.2)' }
                    : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
                  }
                >
                  {n}
                </button>
              ))}
              <div
                className="flex items-center gap-2 px-4 h-14 rounded-xl"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-color)',
                }}
              >
                <label
                  htmlFor="custom-gpu-count"
                  className="text-sm"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Custom
                </label>
                <input
                  id="custom-gpu-count"
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  value={gpuCount}
                  onChange={(e) => {
                    const raw = parseInt(e.target.value, 10)
                    if (Number.isNaN(raw)) return
                    const clamped = Math.max(1, Math.min(64, raw))
                    setGpuCount(clamped)
                  }}
                  className="w-20 h-9 px-2 rounded-lg text-center font-bold"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                  }}
                />
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Need more than 64 GPUs? Contact us for an enterprise quote.
            </p>
          </FormSection>

          <FormSection title="Duration">
            <div className="flex gap-3 flex-wrap items-center">
              {DURATION_OPTIONS.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  disabled={rentalTier === 'RESERVED'}
                  className="px-5 h-14 rounded-xl font-bold text-lg transition-all duration-200"
                  style={duration === d && rentalTier !== 'RESERVED'
                    ? { background: 'var(--primary)', color: '#fff', boxShadow: '0 0 10px rgba(34,197,94,0.2)' }
                    : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', opacity: rentalTier === 'RESERVED' ? 0.5 : 1 }
                  }
                >
                  {d}d
                </button>
              ))}
              <div
                className="flex items-center gap-2 px-4 h-14 rounded-xl"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-color)',
                  opacity: rentalTier === 'RESERVED' ? 0.5 : 1,
                }}
              >
                <label
                  htmlFor="custom-duration"
                  className="text-sm"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Custom
                </label>
                <input
                  id="custom-duration"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  value={duration}
                  disabled={rentalTier === 'RESERVED'}
                  onChange={(e) => {
                    const raw = parseInt(e.target.value, 10)
                    if (Number.isNaN(raw)) return
                    const clamped = Math.max(1, Math.min(365, raw))
                    setDuration(clamped)
                  }}
                  className="w-20 h-9 px-2 rounded-lg text-center font-bold"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                  }}
                />
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>d</span>
              </div>
            </div>
            {rentalTier === 'RESERVED' && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Reserved tier locks duration to the commitment period ({commitmentDays} days).
              </p>
            )}
          </FormSection>
        </FormCard>

        {/* M4.4: Region (optional). Any region default = allocator
            picks from the global pool. Specific region hard-filters
            to that region's nodes; if none online the request waits
            in PENDING with NO_REGION_CAPACITY flag visible to admin. */}
        <FormCard
          title="Region"
          description="Pin the rental to a specific region or let the allocator pick from the whole network."
          icon={Globe}
        >
          <FormSection>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {REGION_OPTIONS.map(opt => {
                const isActive = requiredRegion === opt.value
                return (
                  <button
                    key={opt.value || 'any'}
                    type="button"
                    onClick={() => setRequiredRegion(opt.value)}
                    className="rounded-md px-3 py-2.5 text-left transition-colors"
                    style={isActive
                      ? {
                          background: 'rgba(34,197,94,0.10)',
                          border: '1px solid rgba(34,197,94,0.45)',
                          color: 'var(--text-primary)',
                        }
                      : {
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border-color)',
                          color: 'var(--text-secondary)',
                        }
                    }
                  >
                    <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      {opt.label}
                    </p>
                    {opt.value && (
                      <p className="font-mono text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {opt.value}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Pinning a region narrows the pool. If no nodes are online in your chosen region the request will wait in queue until capacity appears.
            </p>
          </FormSection>
        </FormCard>

        {/* Purpose */}
        <FormCard
          title="Purpose"
          description="What will you use this compute for? Optional but helpful."
          icon={FileText}
        >
          <FormSection>
            <textarea
              className="w-full rounded-lg px-4 py-2.5 transition-colors min-h-[80px] resize-y"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
              }}
              placeholder="e.g. ML training, inference, rendering..."
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
            />
          </FormSection>
        </FormCard>

        {/* Checkpoint Workspace restore. Optional. Lists every prior
            rental that has a READY checkpoint; picking one tells the
            agent to download the tarball from S3 and unpack it into
            the new rental's home dir before SSH opens. Hidden entirely
            when the buyer has no READY checkpoints yet so first-timers
            don't see an empty picker. */}
        {restoreOptions.length > 0 && (
          <FormCard
            title="Restore from a previous workspace"
            description="Optional. Pick a snapshot from a prior rental to drop into this new one before SSH opens."
            icon={Save}
          >
            <FormSection>
              <select
                className="w-full rounded-lg px-3 py-2.5 transition-colors"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                }}
                value={restoreCheckpointId}
                onChange={e => setRestoreCheckpointId(e.target.value)}
              >
                <option value="">Start with a fresh workspace</option>
                {restoreOptions.map(opt => {
                  const readyAt = opt.checkpointReadyAt
                    ? new Date(opt.checkpointReadyAt).toLocaleString()
                    : new Date(opt.requestedAt).toLocaleDateString()
                  return (
                    <option key={opt.checkpointId} value={opt.checkpointId}>
                      {opt.gpuTier} rental · checkpointed {readyAt}
                    </option>
                  )
                })}
              </select>
              {restoreCheckpointId && (
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  Heads up: the snapshot was taken on a {restoreOptions.find(o => o.checkpointId === restoreCheckpointId)?.gpuTier} rental.
                  Restoring across different GPU tiers usually works, but framework caches
                  (CUDA toolkits, model weights) may need a refresh if they reference the old hardware.
                </p>
              )}
            </FormSection>
          </FormCard>
        )}

        {/* M6: SSH public key. Required because the agent on the
            operator's machine installs this into the rental user's
            authorized_keys at provision time — without it, the rental
            lands in FAILED status. */}
        <FormCard
          title="SSH public key"
          description="Required. The operator's machine will authorize this key so you can SSH in once the rental activates."
          icon={KeyRound}
        >
          <FormSection>
            <textarea
              className="w-full rounded-lg px-4 py-2.5 transition-colors font-mono text-xs min-h-[100px] resize-y"
              style={{
                background: 'var(--bg-elevated)',
                border:
                  sshPubKey.trim() === '' || SSH_PUBKEY_REGEX.test(sshPubKey.trim())
                    ? '1px solid var(--border-color)'
                    : '1px solid rgba(239, 68, 68, 0.5)',
                color: 'var(--text-primary)',
              }}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... you@laptop"
              value={sshPubKey}
              onChange={e => setSshPubKey(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {sshPubKey.trim() !== '' && !SSH_PUBKEY_REGEX.test(sshPubKey.trim()) && (
              <p className="text-xs mt-2" style={{ color: '#ef4444' }}>
                Doesn&rsquo;t look like an SSH public key. It should start with{' '}
                <code>ssh-rsa</code>, <code>ssh-ed25519</code>, or{' '}
                <code>ecdsa-sha2-nistp...</code>.
              </p>
            )}
            <details className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              <summary className="cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
                How do I find my public key?
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                <p>
                  On macOS or Linux, open a terminal and run{' '}
                  <code
                    className="px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                  >
                    cat ~/.ssh/id_ed25519.pub
                  </code>{' '}
                  (or{' '}
                  <code
                    className="px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                  >
                    ~/.ssh/id_rsa.pub
                  </code>{' '}
                  for older RSA keys), then copy the entire single line.
                </p>
                <p>
                  On Windows, open PowerShell and run{' '}
                  <code
                    className="px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                  >
                    Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
                  </code>
                  .
                </p>
                <p>
                  No key yet? Generate one with{' '}
                  <code
                    className="px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                  >
                    ssh-keygen -t ed25519
                  </code>{' '}
                  and accept the defaults — your public key lands at the path above.
                </p>
                <p style={{ color: 'var(--text-muted)' }}>
                  Paste the <strong>public</strong> key (.pub file). Never share your private key.
                </p>
              </div>
            </details>
          </FormSection>
        </FormCard>

        {/* Cost Summary */}
        {selectedTier && (
          <FormCard
            title="Cost Summary"
            description="Total payable up-front before submitting"
            icon={Receipt}
          >
            <FormSection>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span style={{ color: 'var(--text-muted)' }}>{selectedTier} x {gpuCount} GPU(s)</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>${dailyRate.toFixed(2)}/day x {gpuCount}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span style={{ color: 'var(--text-muted)' }}>Duration</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{effectiveDuration} days</span>
                </div>
                <div className="pt-3 flex justify-between" style={{ borderTop: '1px solid var(--border-color)' }}>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Total</span>
                  <span className="text-2xl font-bold font-mono" style={{ color: 'var(--primary)' }}>${totalCost.toFixed(2)}</span>
                </div>
              </div>
            </FormSection>
          </FormCard>
        )}

        {/* Payment method picker — shown when the buyer has at least
            one balance route available (operator earnings OR pre-loaded
            buyer credit). Pure first-time buyers never see this section
            and stay on the legacy USDC-only flow. */}
        {showPaymentPicker && (
          <FormCard
            title="Payment method"
            description="Pay with USDC on Solana or draw from a balance you have already loaded."
            icon={CreditCard}
          >
            <FormSection>
              <div
                className={`grid grid-cols-1 ${internalEligible && buyerBalanceUsd > 0 ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-3`}
              >
                <button
                  type="button"
                  onClick={() => setPaymentSource('USDC')}
                  className="text-left rounded-xl p-4 transition-all duration-200"
                  style={paymentSource === 'USDC'
                    ? { background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.45)', boxShadow: '0 0 12px rgba(34,197,94,0.18)' }
                    : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                  }
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>USDC on Solana</span>
                    <Wallet size={16} style={{ color: 'var(--primary)' }} />
                  </div>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Pay with a Solana USDC transfer.</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Requires a transaction hash.</p>
                </button>

                {buyerBalanceUsd > 0 && (
                  <button
                    type="button"
                    onClick={() => setPaymentSource('BUYER_BALANCE')}
                    className="text-left rounded-xl p-4 transition-all duration-200"
                    style={paymentSource === 'BUYER_BALANCE'
                      ? { background: 'rgba(6,182,212,0.10)', border: '1px solid rgba(6,182,212,0.45)', boxShadow: '0 0 12px rgba(6,182,212,0.18)' }
                      : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                    }
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Pre-loaded balance</span>
                      <Wallet size={16} style={{ color: '#06b6d4' }} />
                    </div>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      Available: <span className="font-mono">${buyerBalanceUsd.toFixed(2)}</span>
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      Pulls from credit you topped up. Settles instantly.
                    </p>
                  </button>
                )}

                {internalEligible && (
                  <button
                    type="button"
                    onClick={() => setPaymentSource('INTERNAL_BALANCE')}
                    className="text-left rounded-xl p-4 transition-all duration-200"
                    style={paymentSource === 'INTERNAL_BALANCE'
                      ? { background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.45)', boxShadow: '0 0 12px rgba(59,130,246,0.18)' }
                      : { background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }
                    }
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Operator balance</span>
                      <PiggyBank size={16} style={{ color: 'var(--info, #3b82f6)' }} />
                    </div>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      Available: <span className="font-mono">${internalAvailable.toFixed(2)}</span>
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      Earned from running nodes. No on-chain tx, no cool-down.
                    </p>
                  </button>
                )}
              </div>

              {internalShort && (
                <p
                  className="text-xs mt-3 px-3 py-2 rounded-md"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.25)',
                    color: '#ef4444',
                  }}
                >
                  Need <span className="font-mono">${totalCost.toFixed(2)}</span> but only <span className="font-mono">${internalAvailable.toFixed(2)}</span> in operator balance. Reduce GPU count / duration or switch payment method.
                </p>
              )}
              {buyerBalanceShort && (
                <p
                  className="text-xs mt-3 px-3 py-2 rounded-md"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.25)',
                    color: '#ef4444',
                  }}
                >
                  Need <span className="font-mono">${totalCost.toFixed(2)}</span> but only <span className="font-mono">${buyerBalanceUsd.toFixed(2)}</span> in your balance. Top up at <a href="/buyer/balance" className="underline">Balance</a> or switch to USDC.
                </p>
              )}
            </FormSection>
          </FormCard>
        )}

        {/* Payment confirmation. USDC has two sub-states: wallet
            sign-and-pay (preferred when a wallet is connected) and
            manual paste (collapsible fallback for hardware wallets,
            multisigs, exchange withdrawals, etc.). The two balance
            paths degrade to a confirm panel showing the debit math —
            no hash needed in any case. */}
        <FormCard
          title="Payment"
          description={
            paymentSource === 'USDC'
              ? walletPaySelected
                ? `Sign a USDC transfer in ${wallet?.adapter.name ?? 'your wallet'}. Funds confirm on Solana in a few seconds.`
                : 'Paste your Solana transaction hash after sending payment, or connect a wallet to sign automatically.'
              : paymentSource === 'BUYER_BALANCE'
                ? 'Confirm the debit from your pre-loaded balance.'
                : 'Confirm the debit from your operator balance.'
          }
          icon={Wallet}
          footer={
            <Button
              size="lg"
              onClick={handleSubmit}
              loading={submitting}
              disabled={
                !selectedTier ||
                (paymentSource === 'USDC' && !walletPaySelected && !txHash.trim()) ||
                internalShort ||
                buyerBalanceShort
              }
              className="px-8"
            >
              {walletPaySelected ? (
                <>
                  <Zap size={16} className="mr-2" />
                  {walletPhase === 'signing'
                    ? 'Awaiting wallet…'
                    : walletPhase === 'submitting'
                      ? 'Submitting…'
                      : `Pay $${totalCost.toFixed(2)} & Submit`}
                </>
              ) : (
                <>
                  <Hash size={16} className="mr-2" />
                  Submit Request
                </>
              )}
            </Button>
          }
        >
          <FormSection>
            {paymentSource === 'USDC' ? (
              walletPaySelected ? (
                // Wallet sign-and-pay primary block
                <div className="space-y-3">
                  <div
                    className="rounded-md p-4 flex items-center gap-3"
                    style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}
                  >
                    <Zap size={18} style={{ color: 'var(--primary)' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        Pay with {wallet?.adapter.name ?? 'connected wallet'}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        Submitting will prompt {wallet?.adapter.name ?? 'your wallet'} to sign a USDC transfer of <span className="font-mono">${totalCost.toFixed(2)}</span>.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowManualPaste(true)}
                    className="text-sm font-medium hover:opacity-80 transition-opacity underline underline-offset-4"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Send from another wallet instead
                  </button>
                </div>
              ) : (
                // Paste fallback (and "Connect Wallet" CTA when no wallet).
                // Shows the destination wallet prominently so the operator
                // knows where to send USDC before pasting back the hash.
                <div className="space-y-3">
                  {!walletConnected && (
                    <button
                      type="button"
                      onClick={() => openWalletModal(true)}
                      className="w-full inline-flex items-center justify-center gap-2 h-11 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
                      style={{ background: 'var(--primary)', color: '#fff' }}
                    >
                      <Wallet size={16} />
                      Connect wallet to pay automatically
                    </button>
                  )}
                  {topupDestination?.configured && topupDestination.wallet ? (
                    <div
                      className="rounded-lg p-4 space-y-3"
                      style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.25)' }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-mono uppercase tracking-[0.16em] font-semibold" style={{ color: 'var(--primary)' }}>
                          Send USDC to this address
                        </p>
                        <span
                          className="text-[10px] font-mono uppercase tracking-[0.16em] px-2 py-0.5 rounded-full whitespace-nowrap"
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                        >
                          Solana {topupDestination.network}
                        </span>
                      </div>
                      <div className="flex items-stretch gap-2">
                        <code
                          className="flex-1 min-w-0 text-xs font-mono break-all px-3 py-2.5 rounded-md"
                          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
                        >
                          {topupDestination.wallet}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(topupDestination.wallet!)
                            toast('success', 'Address copied')
                          }}
                          className="inline-flex items-center gap-1.5 px-3 rounded-md text-xs font-semibold hover:opacity-90 transition-opacity"
                          style={{ background: 'var(--primary)', color: '#fff' }}
                        >
                          <Copy size={14} />
                          Copy
                        </button>
                      </div>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        Send exactly{' '}
                        <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                          ${totalCost.toFixed(2)} USDC
                        </span>{' '}
                        to the address above, then paste the resulting transaction signature below. The wrong amount or address will fail to credit your rental.
                      </p>
                    </div>
                  ) : (
                    <div
                      className="rounded-lg p-3 text-xs"
                      style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', color: 'var(--warning)' }}
                    >
                      Topup destination is not configured. Contact support before paying.
                    </div>
                  )}
                  <Input
                    label="Transaction Hash (Solana)"
                    placeholder="Paste the Solana transaction signature..."
                    value={txHash}
                    onChange={e => setTxHash(e.target.value)}
                  />
                  {walletConnected && showManualPaste && (
                    <button
                      type="button"
                      onClick={() => setShowManualPaste(false)}
                      className="text-sm font-medium hover:opacity-80 transition-opacity underline underline-offset-4"
                      style={{ color: 'var(--primary)' }}
                    >
                      ← Pay with connected wallet instead
                    </button>
                  )}
                </div>
              )
            ) : (() => {
              const before = paymentSource === 'BUYER_BALANCE' ? buyerBalanceUsd : internalAvailable
              const short = paymentSource === 'BUYER_BALANCE' ? buyerBalanceShort : internalShort
              return (
                <div
                  className="rounded-md p-4 space-y-2 text-sm"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
                >
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-muted)' }}>Balance before</span>
                    <span className="font-mono" style={{ color: 'var(--text-primary)' }}>${before.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-muted)' }}>This rental</span>
                    <span className="font-mono" style={{ color: '#ef4444' }}>-${totalCost.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between pt-2" style={{ borderTop: '1px solid var(--border-color)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Balance after</span>
                    <span
                      className="font-mono font-semibold"
                      style={{ color: short ? '#ef4444' : 'var(--primary)' }}
                    >
                      ${Math.max(0, before - totalCost).toFixed(2)}
                    </span>
                  </div>
                </div>
              )
            })()}
          </FormSection>
        </FormCard>
      </div>
    </DashboardShell>
  )
}
