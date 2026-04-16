'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Server, CircleCheck, Hash } from 'lucide-react'
import { buyer } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'

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

const DURATION_OPTIONS = [7, 14, 30, 60, 90]

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function RequestComputePage() {
  const router = useRouter()
  const { toast } = useToast()
  const [selectedTier, setSelectedTier] = useState<string | null>(null)
  const [gpuCount, setGpuCount] = useState(1)
  const [duration, setDuration] = useState(30)
  const [purpose, setPurpose] = useState('')
  const [txHash, setTxHash] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const hourlyRate = selectedTier ? HOURLY_RATES[selectedTier] ?? 0 : 0
  const dailyRate = hourlyRate * 24
  const totalCost = dailyRate * gpuCount * duration

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
        durationDays: duration,
        purpose: purpose.trim() || undefined,
        txHash: txHash.trim(),
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
    <motion.div
      className="space-y-8"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="relative py-6">
        <div className="absolute inset-0 rounded-2xl" style={{ background: 'linear-gradient(to bottom, rgba(59,130,246,0.05), transparent)' }} />
        <div className="relative">
          <div className="flex items-center gap-3">
            <Server size={28} style={{ color: 'var(--primary)' }} />
            <h1 className="text-2xl md:text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Request Compute</h1>
          </div>
          <p className="mt-1" style={{ color: 'var(--text-muted)' }}>Select your GPU tier, quantity, and rental duration.</p>
        </div>
      </motion.div>

      {/* GPU Tier Selector */}
      <motion.div variants={item}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Select GPU Tier</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {GPU_TIERS.map(t => {
            const isSelected = selectedTier === t.id
            const ts = TIER_STYLES[t.id]!
            const hr = HOURLY_RATES[t.id] ?? 0
            const dr = hr * 24
            return (
              <button
                key={t.id}
                onClick={() => setSelectedTier(t.id)}
                className="relative text-left rounded-xl p-5 transition-all duration-200"
                style={isSelected
                  ? {
                      border: `1px solid ${ts.border}`,
                      background: ts.bg,
                      boxShadow: `${ts.glow}, 0 0 0 1px ${ts.ring}`,
                    }
                  : {
                      border: '1px solid var(--border-color)',
                      background: 'var(--glass-bg)',
                    }
                }
              >
                {isSelected && (
                  <div className="absolute top-3 right-3">
                    <CircleCheck size={20} style={{ color: ts.text }} />
                  </div>
                )}
                <div
                  className="text-lg font-bold mb-1"
                  style={{ color: isSelected ? ts.text : 'var(--text-primary)' }}
                >
                  {t.name}
                </div>
                <div className="space-y-1.5 text-sm mt-3">
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-muted)' }}>Hourly</span>
                    <span className="font-medium" style={{ color: 'var(--primary)' }}>${hr.toFixed(2)}/hr</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-muted)' }}>Daily</span>
                    <span className="font-medium" style={{ color: 'var(--primary)' }}>${dr.toFixed(2)}/day</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </motion.div>

      {/* GPU Count */}
      <motion.div variants={item}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Number of GPUs</h2>
        <div className="flex gap-3 flex-wrap">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
            <button
              key={n}
              onClick={() => setGpuCount(n)}
              className="w-14 h-14 rounded-xl font-bold text-lg transition-all duration-200"
              style={gpuCount === n
                ? { background: 'var(--primary)', color: '#fff', boxShadow: '0 0 10px rgba(34,197,94,0.2)' }
                : { background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
              }
            >
              {n}
            </button>
          ))}
        </div>
      </motion.div>

      {/* Duration */}
      <motion.div variants={item}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Duration</h2>
        <div className="flex gap-3 flex-wrap">
          {DURATION_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => setDuration(d)}
              className="px-5 h-14 rounded-xl font-bold text-lg transition-all duration-200"
              style={duration === d
                ? { background: 'var(--primary)', color: '#fff', boxShadow: '0 0 10px rgba(34,197,94,0.2)' }
                : { background: 'var(--bg-card)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }
              }
            >
              {d}d
            </button>
          ))}
        </div>
      </motion.div>

      {/* Cost Summary */}
      {selectedTier && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-6"
            style={{
              background: 'linear-gradient(to right, rgba(34,197,94,0.05), var(--glass-bg))',
              border: '1px solid rgba(34,197,94,0.2)',
            }}
          >
            <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Cost Summary</h2>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span style={{ color: 'var(--text-muted)' }}>{selectedTier} x {gpuCount} GPU(s)</span>
                <span style={{ color: 'var(--text-secondary)' }}>${dailyRate.toFixed(2)}/day x {gpuCount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span style={{ color: 'var(--text-muted)' }}>Duration</span>
                <span style={{ color: 'var(--text-secondary)' }}>{duration} days</span>
              </div>
              <div className="pt-3 flex justify-between" style={{ borderTop: '1px solid var(--border-color)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Total</span>
                <span className="text-2xl font-bold" style={{ color: 'var(--primary)' }}>${totalCost.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Purpose */}
      <motion.div variants={item} className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Purpose (optional)</label>
          <textarea
            className="w-full rounded-lg px-4 py-2.5 transition-colors min-h-[80px] resize-y"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
            }}
            placeholder="What will you use this compute for? (e.g. ML training, inference, rendering...)"
            value={purpose}
            onChange={e => setPurpose(e.target.value)}
          />
        </div>
      </motion.div>

      {/* Payment */}
      <motion.div variants={item} className="space-y-4">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Payment</h2>
        <Input
          label="Transaction Hash (Solana)"
          placeholder="Enter your Solana transaction hash or 'test_tx' for testing..."
          value={txHash}
          onChange={e => setTxHash(e.target.value)}
        />
      </motion.div>

      {/* Submit */}
      <motion.div variants={item} className="flex justify-end pt-2">
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
      </motion.div>
    </motion.div>
  )
}
