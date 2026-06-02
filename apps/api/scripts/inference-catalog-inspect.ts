/**
 * Track 5 / E1-E3 — inference catalog inspector.
 *
 * Single-shot tool that prints, for every active model in
 * ModelPricing, whether the env vars needed to actually serve it are
 * configured. Answers the question:
 *
 *   "After all my seeds + env var changes, what models are actually
 *    callable right now?"
 *
 *   pnpm --filter @a2e/api inference-catalog:inspect
 *
 * Groups by route family (chat / embeddings / images / audio) and
 * highlights gaps so the next env-var update is obvious.
 */
import { prisma } from '@a2e/database'

interface ModelRow {
  modelId: string
  family: 'chat' | 'embedding' | 'image' | 'audio' | 'unknown'
  provider: string
  apiKeyEnv: string
  apiKeySet: boolean
  inputPricePerMillionTokens: number
  outputPricePerMillionTokens: number
  hasImagePricing: boolean
  hasAudioPricing: boolean
  metadata: Record<string, unknown>
}

function classifyFamily(row: { metadata: Record<string, unknown>; modelId: string; inputPricePerMillionTokens: number; outputPricePerMillionTokens: number }): ModelRow['family'] {
  const m = row.metadata
  if (m.imagePricing) return 'image'
  if (m.audioPricing) return 'audio'
  const family = typeof m.family === 'string' ? m.family : ''
  if (family.startsWith('embedding')) return 'embedding'
  if (/embedding/i.test(row.modelId)) return 'embedding'
  // Per-token priced models without image/audio metadata default to chat.
  if (row.inputPricePerMillionTokens > 0 || row.outputPricePerMillionTokens > 0) return 'chat'
  return 'unknown'
}

function resolveProviderConfig(metadata: Record<string, unknown>): { provider: string; apiKeyEnv: string } {
  const kind = typeof metadata.externalProvider === 'string' ? metadata.externalProvider : '(none)'
  if (kind === 'openai') return { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }
  if (kind === 'anthropic') return { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }
  if (kind === 'openai-compat') {
    const env = typeof metadata.externalApiKeyEnv === 'string' ? metadata.externalApiKeyEnv : '(unset)'
    const base = typeof metadata.externalBaseUrl === 'string' ? metadata.externalBaseUrl : '(no baseUrl)'
    return { provider: `openai-compat (${base})`, apiKeyEnv: env }
  }
  return { provider: kind, apiKeyEnv: '(no env)' }
}

async function main(): Promise<void> {
  const rows = await prisma.modelPricing.findMany({
    where: { isActive: true },
    orderBy: { modelId: 'asc' },
  })

  const analyzed: ModelRow[] = rows.map((r) => {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>
    const { provider, apiKeyEnv } = resolveProviderConfig(metadata)
    const apiKeySet = apiKeyEnv !== '(no env)' && apiKeyEnv !== '(unset)' && !!process.env[apiKeyEnv]?.trim()
    return {
      modelId: r.modelId,
      family: classifyFamily({ metadata, modelId: r.modelId, inputPricePerMillionTokens: r.inputPricePerMillionTokens, outputPricePerMillionTokens: r.outputPricePerMillionTokens }),
      provider,
      apiKeyEnv,
      apiKeySet,
      inputPricePerMillionTokens: r.inputPricePerMillionTokens,
      outputPricePerMillionTokens: r.outputPricePerMillionTokens,
      hasImagePricing: !!metadata.imagePricing,
      hasAudioPricing: !!metadata.audioPricing,
      metadata,
    }
  })

  // ---------------- Env var summary ----------------
  console.log('Environment summary:')
  const envs = ['OPENAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'TOGETHER_API_KEY']
  for (const env of envs) {
    const v = process.env[env]?.trim()
    const mask = v ? `${v.slice(0, 8)}...${v.slice(-4)}` : '(unset)'
    console.log(`  ${env.padEnd(22)} ${v ? 'set' : 'MISSING'}  ${mask}`)
  }
  console.log()

  // ---------------- By family ----------------
  const families: Array<{ key: ModelRow['family']; label: string }> = [
    { key: 'chat', label: 'CHAT COMPLETIONS  (/v1/chat/completions)' },
    { key: 'embedding', label: 'EMBEDDINGS        (/v1/embeddings)' },
    { key: 'image', label: 'IMAGE GENERATION  (/v1/images/generations)' },
    { key: 'audio', label: 'AUDIO TRANSCRIPT  (/v1/audio/transcriptions)' },
    { key: 'unknown', label: 'UNCLASSIFIED' },
  ]

  for (const family of families) {
    const subset = analyzed.filter((r) => r.family === family.key)
    if (subset.length === 0) continue
    console.log(family.label)
    console.log('-'.repeat(family.label.length))
    for (const r of subset) {
      const status = r.apiKeySet ? 'READY' : 'NEED KEY'
      const price = r.family === 'image' || r.family === 'audio'
        ? '(per-unit)'
        : `$${r.inputPricePerMillionTokens.toFixed(2)}/M in, $${r.outputPricePerMillionTokens.toFixed(2)}/M out`
      console.log(`  [${status}]  ${r.modelId.padEnd(48)} via ${r.apiKeyEnv.padEnd(18)} ${price}`)
    }
    console.log()
  }

  // ---------------- Gaps ----------------
  const gaps = analyzed.filter((r) => !r.apiKeySet)
  if (gaps.length > 0) {
    console.log('Models seeded but BLOCKED on missing API key:')
    const byEnv = new Map<string, string[]>()
    for (const g of gaps) {
      const list = byEnv.get(g.apiKeyEnv) ?? []
      list.push(g.modelId)
      byEnv.set(g.apiKeyEnv, list)
    }
    for (const [env, models] of byEnv) {
      console.log(`  ${env} missing -> ${models.length} model(s):`)
      for (const id of models) console.log(`    ${id}`)
    }
    console.log()
  }

  // ---------------- Counts ----------------
  console.log('Catalog totals:')
  for (const f of families) {
    const total = analyzed.filter((r) => r.family === f.key).length
    const ready = analyzed.filter((r) => r.family === f.key && r.apiKeySet).length
    if (total === 0) continue
    console.log(`  ${f.label.padEnd(50)} ${ready}/${total} ready`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
