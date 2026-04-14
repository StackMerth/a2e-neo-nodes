'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'

interface GpuTier {
  id: string
  name: string
  price: number
  dailyYield: number
}

const GPU_TIERS: GpuTier[] = [
  { id: 'H100', name: 'H100', price: 2500, dailyYield: 140.15 },
  { id: 'H200', name: 'H200', price: 3125, dailyYield: 179.85 },
  { id: 'B200', name: 'B200', price: 5250, dailyYield: 321.10 },
  { id: 'B300', name: 'B300', price: 7500, dailyYield: 431.75 },
  { id: 'GB300', name: 'GB300', price: 9000, dailyYield: 499.35 },
]

const TIER_COLORS: Record<string, string> = {
  H100: 'border-accent/40 bg-accent/5 shadow-[0_0_20px_theme(colors.accent/0.1)]',
  H200: 'border-accent-blue/40 bg-accent-blue/5 shadow-[0_0_20px_theme(colors.accent-blue/0.1)]',
  B200: 'border-accent-purple/40 bg-accent-purple/5 shadow-[0_0_20px_theme(colors.accent-purple/0.1)]',
  B300: 'border-accent-orange/40 bg-accent-orange/5 shadow-[0_0_20px_theme(colors.accent-orange/0.1)]',
  GB300: 'border-error/40 bg-error/5 shadow-[0_0_20px_theme(colors.error/0.1)]',
}

const TIER_TEXT: Record<string, string> = {
  H100: 'text-accent',
  H200: 'text-accent-blue',
  B200: 'text-accent-purple',
  B300: 'text-accent-orange',
  GB300: 'text-error',
}

export default function DeployPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [selectedTier, setSelectedTier] = useState<string | null>(null)
  const [nodeCount, setNodeCount] = useState(1)
  const [txHash, setTxHash] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const tier = GPU_TIERS.find(t => t.id === selectedTier)
  const totalCost = tier ? tier.price * nodeCount : 0
  const monthlyYield = tier ? tier.dailyYield * 30 * nodeCount : 0
  const roi30d = tier ? ((tier.dailyYield * 30) / tier.price) * 100 : 0

  async function handleSubmit() {
    if (!selectedTier || !txHash.trim()) {
      toast('error', 'Please select a GPU tier and enter a transaction hash')
      return
    }

    setSubmitting(true)
    try {
      await nodeRunner.deploy({
        gpuTier: selectedTier,
        nodeCount,
        txHash: txHash.trim(),
        deploymentNote: note.trim() || undefined,
      })
      toast('success', 'Deployment request submitted successfully')
      router.push('/deployments')
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to submit deployment request')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="relative py-6">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-2xl" />
        <div className="relative">
          <h1 className="text-2xl md:text-3xl font-bold text-text-primary">Deploy a Node</h1>
          <p className="text-text-muted mt-1">Select your GPU tier, choose how many nodes to deploy, and submit payment.</p>
        </div>
      </div>

      {/* GPU Tier Selector */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-4">Select GPU Tier</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {GPU_TIERS.map(t => {
            const isSelected = selectedTier === t.id
            const tierRoi = ((t.dailyYield * 30) / t.price) * 100
            return (
              <button
                key={t.id}
                onClick={() => setSelectedTier(t.id)}
                className={`relative text-left rounded-xl border p-5 transition-all duration-200 ${
                  isSelected
                    ? `${TIER_COLORS[t.id]} ring-1 ring-offset-0 ${t.id === 'H100' ? 'ring-accent/50' : t.id === 'H200' ? 'ring-accent-blue/50' : t.id === 'B200' ? 'ring-accent-purple/50' : t.id === 'B300' ? 'ring-accent-orange/50' : 'ring-error/50'}`
                    : 'border-border bg-surface hover:border-accent/20 hover:bg-surface-hover'
                }`}
              >
                {isSelected && (
                  <div className="absolute top-3 right-3">
                    <svg className={`w-5 h-5 ${TIER_TEXT[t.id]}`} fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
                <div className={`text-lg font-bold mb-1 ${isSelected ? TIER_TEXT[t.id] : 'text-text-primary'}`}>
                  {t.name}
                </div>
                <div className="text-2xl font-bold text-text-primary mb-3">
                  ${t.price.toLocaleString()}
                </div>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Daily Yield</span>
                    <span className="text-accent font-medium">${t.dailyYield.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">30d ROI</span>
                    <span className="text-accent font-medium">{tierRoi.toFixed(1)}%</span>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Node Count */}
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-4">Number of Nodes</h2>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onClick={() => setNodeCount(n)}
              className={`w-14 h-14 rounded-xl font-bold text-lg transition-all duration-200 ${
                nodeCount === n
                  ? 'bg-accent text-white shadow-glow-sm'
                  : 'bg-surface border border-border text-text-secondary hover:border-accent/30 hover:text-text-primary'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Cost Summary */}
      {tier && (
        <Card className="p-6 bg-gradient-to-r from-accent/5 via-surface to-surface border-accent/20">
          <h2 className="text-lg font-semibold text-text-primary mb-4">Cost Summary</h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">{tier.name} x {nodeCount}</span>
              <span className="text-text-secondary">${tier.price.toLocaleString()} x {nodeCount}</span>
            </div>
            <div className="border-t border-border pt-3 flex justify-between">
              <span className="font-semibold text-text-primary">Total</span>
              <span className="text-2xl font-bold text-accent">${totalCost.toLocaleString()}</span>
            </div>
            <div className="border-t border-border pt-3 space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">Est. Monthly Yield</span>
                <span className="text-accent font-medium">${monthlyYield.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">30-Day ROI</span>
                <span className="text-accent font-medium">{roi30d.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Payment */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">Payment</h2>
        <Input
          label="Transaction Hash (Solana)"
          placeholder="Enter your Solana transaction hash..."
          value={txHash}
          onChange={e => setTxHash(e.target.value)}
        />
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-text-secondary">Deployment Note (optional)</label>
          <textarea
            className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors min-h-[80px] resize-y"
            placeholder="Any special instructions or notes..."
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>
      </div>

      {/* Submit */}
      <div className="flex justify-end pt-2">
        <Button
          size="lg"
          onClick={handleSubmit}
          loading={submitting}
          disabled={!selectedTier || !txHash.trim()}
          className="px-8"
        >
          Request Deployment
        </Button>
      </div>
    </div>
  )
}
