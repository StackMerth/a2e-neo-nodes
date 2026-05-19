/**
 * C2 wave 2 standalone classifier check.
 *
 * Exercises the agent's GpuDetector against a fixed list of mock GPU
 * model strings and prints the resulting tier mapping. Doesn't need an
 * apiKey, a Docker daemon, or a running API — pure detection logic.
 *
 * Usage (Local PowerShell):
 *
 *   cd "C:\Users\XPS\Documents\Vs Code Projects\a2e engine\a2e-engine"
 *   pnpm --filter @a2e/node-agent test:gpu-classifier
 *
 * The script prints a table of model -> tier expectations. Any row
 * with an ❌ means the mapping changed and probably needs to be fixed
 * in apps/node-agent/src/gpu/detector.ts.
 */

import { GpuDetector } from '../src/gpu/detector.js'
import type { GpuTier } from '../src/api/types.js'

interface Case {
  model: string
  expected: GpuTier
}

const CASES: Case[] = [
  // C2 wave 2 additions
  { model: 'NVIDIA GeForce RTX 4090', expected: 'RTX_4090' },
  { model: 'GeForce RTX 4090', expected: 'RTX_4090' },
  { model: 'RTX 4090', expected: 'RTX_4090' },
  { model: 'NVIDIA GeForce RTX 3090 Ti', expected: 'RTX_3090' },
  { model: 'GeForce RTX 3090', expected: 'RTX_3090' },
  // CONSUMER catchall — any unknown GeForce / RTX falls into this bucket
  { model: 'NVIDIA GeForce RTX 4070', expected: 'CONSUMER' },
  { model: 'NVIDIA GeForce RTX 3060', expected: 'CONSUMER' },
  { model: 'GeForce RTX 5080', expected: 'CONSUMER' },
  // Datacenter regression checks — must still pass after C2 changes
  { model: 'NVIDIA H100 80GB HBM3', expected: 'H100' },
  { model: 'H100 SXM5', expected: 'H100' },
  { model: 'NVIDIA H200', expected: 'H200' },
  { model: 'NVIDIA B200', expected: 'B200' },
  { model: 'NVIDIA B300', expected: 'B300' },
  { model: 'NVIDIA GB300', expected: 'GB300' },
]

async function detectTierFor(model: string): Promise<GpuTier> {
  // GpuDetector.detect() in mock mode just returns whatever model
  // the config says + classifies it through the same GPU_TIER_MAP path
  // a live nvidia-smi would feed it.
  const detector = new GpuDetector({
    autoDetect: true,
    mockGpu: true,
    mockModel: model,
    mockVram: 24_000,
  })
  const info = await detector.detect()
  if (!info) throw new Error(`detect() returned null for ${model}`)
  return info.tier
}

async function main() {
  let pass = 0
  let fail = 0
  const lines: string[] = []
  for (const c of CASES) {
    try {
      const got = await detectTierFor(c.model)
      const ok = got === c.expected
      if (ok) pass++
      else fail++
      lines.push(
        `  ${ok ? '✅' : '❌'}  ${c.model.padEnd(35)}  expected=${c.expected.padEnd(10)}  got=${got}`,
      )
    } catch (e) {
      fail++
      const msg = e instanceof Error ? e.message : String(e)
      lines.push(`  ❌  ${c.model.padEnd(35)}  expected=${c.expected.padEnd(10)}  ERROR: ${msg}`)
    }
  }

  console.log('')
  console.log('=== GPU classifier check ===')
  for (const line of lines) console.log(line)
  console.log('')
  console.log(`Result: ${pass} passed, ${fail} failed (${CASES.length} total)`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
