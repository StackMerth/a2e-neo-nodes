'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Server, CircleCheck, Hash, Layers, Calendar, FileText, Wallet, Receipt } from 'lucide-react'
import { buyer } from '@/lib/api'
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
}

const GPU_TIERS: GpuTier[] = [
  { id: 'H100', name: 'H100', dailyRate: 5.84 * 24 > 140 ? 5.84 : 5.84 },
  { id: 'H200', name: 'H200', dailyRate: 7.49 },
  { id: 'B200', name: 'B200', dailyRate: 13.38 },
  { id: 'B300', name: 'B300', dailyRate: 17.99 },
  { id: 'GB300', name: 'GB300', dailyRate: 20.81 },
]

const HOURLY_RATES: Record<string, number> = {
  H100: 5.84,
  H200: 7.49,
  B200: 13.38,
  B300: 17.99,
  GB300: 20.81,
}

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
}

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

export default function RequestComputePage() {
  const router = useRouter()
  const { toast } = useToast()
  const [selectedTier, setSelectedTier] = useState<string | null>(null)
  const [gpuCount, setGpuCount] = useState(1)
  const [duration, setDuration] = useState(30)
  const [purpose, setPurpose] = useState('')
  const [txHash, setTxHash] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // M3: pricing tier + commitment slider for RESERVED
  const [rentalTier, setRentalTier] = useState<RentalTier>('ON_DEMAND')
  const [commitmentDays, setCommitmentDays] = useState<number>(30)

  const hourlyRate = selectedTier ? HOURLY_RATES[selectedTier] ?? 0 : 0
  const tierMultiplier = TIER_OPTIONS.find(t => t.id === rentalTier)?.multiplier ?? 1
  const dailyRate = hourlyRate * 24 * tierMultiplier
  // RESERVED rentals always lock in commitmentDays as the duration,
  // the API enforces this server-side, the UI just mirrors it for the
  // cost preview.
  const effectiveDuration = rentalTier === 'RESERVED' ? commitmentDays : duration
  const totalCost = dailyRate * gpuCount * effectiveDuration

  async function handleSubmit() {
    if (!selectedTier || !txHash.trim()) {
      toast('error', 'Please select a GPU tier and enter a transaction hash')
      return
    }

    setSubmitting(true)
    try {
      const result = await buyer.requestCompute({
        gpuTier: selectedTier,
        gpuCount,
        durationDays: effectiveDuration,
        purpose: purpose.trim() || undefined,
        txHash: txHash.trim(),
        tier: rentalTier,
        commitmentDays: rentalTier === 'RESERVED' ? commitmentDays : undefined,
      }) as { id: string }
      toast('success', 'Compute request submitted successfully')
      router.push(`/buyer/requests/${result.id}`)
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit compute request')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DashboardShell
      title="Request Compute"
      subtitle="Select your GPU tier, quantity, and rental duration"
    >
      <div className="lg:col-span-3 max-w-3xl mx-auto w-full space-y-6">
        {/* GPU Tier */}
        <FormCard
          title="GPU Tier"
          description="Pick the GPU class you need. Pricing scales with tier."
          icon={Server}
        >
          <FormSection>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {GPU_TIERS.map(t => {
                const isSelected = selectedTier === t.id
                const ts = TIER_STYLES[t.id]!
                const hr = HOURLY_RATES[t.id] ?? 0
                const dr = hr * 24
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTier(t.id)}
                    className="relative text-left rounded-xl p-4 transition-all duration-200"
                    style={isSelected
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
                    {isSelected && (
                      <div className="absolute top-3 right-3">
                        <CircleCheck size={18} style={{ color: ts.text }} />
                      </div>
                    )}
                    <div
                      className="text-lg font-bold mb-1"
                      style={{ color: isSelected ? ts.text : 'var(--text-primary)' }}
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

        {/* Payment */}
        <FormCard
          title="Payment"
          description="Paste your Solana transaction hash after sending the payment."
          icon={Wallet}
          footer={
            <Button
              size="lg"
              onClick={handleSubmit}
              loading={submitting}
              disabled={!selectedTier || !txHash.trim()}
              className="px-8"
            >
              <Hash size={16} className="mr-2" />
              Submit Request
            </Button>
          }
        >
          <FormSection>
            <Input
              label="Transaction Hash (Solana)"
              placeholder="Enter your Solana transaction hash..."
              value={txHash}
              onChange={e => setTxHash(e.target.value)}
            />
          </FormSection>
        </FormCard>
      </div>
    </DashboardShell>
  )
}
