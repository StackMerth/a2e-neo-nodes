/**
 * Track 5 / E1 + E2 + E3.1 — seed chat completion + embedding models.
 *
 * Adds OpenAI's GPT-4o family, more Groq free-tier-ish Llama variants,
 * Together AI's Llama/Qwen/DeepSeek, and OpenAI's text-embedding-3-large.
 * Image + audio models live in seed-image-models.ts / seed-audio-models.ts.
 *
 *   pnpm --filter @a2e/api seed:chat-models
 *
 * Re-runnable. Upsert keyed on modelId. Existing rows get pricing +
 * metadata overwritten; brand-new rows created.
 *
 * Pricing strategy:
 *   - For OpenAI we pass through OpenAI's published per-1M-token rates
 *     verbatim. M1.1's revenue split treats the platform as the
 *     'operator' for external-provider calls; treasury earns the
 *     operator slice.
 *   - For Groq we use Groq's published per-1M-token rates (NOT free,
 *     even though their first-time free tier is generous). The buyer
 *     pays the same regardless of which provider we route to.
 *   - For Together AI we use Together's published rates.
 *
 * Required env vars (per route):
 *   OPENAI_API_KEY      — for any openai-prefixed model
 *   GROQ_API_KEY        — for any groq-routed model
 *   TOGETHER_API_KEY    — for any together-routed model
 *
 * Models that need NEW external-provider adapters (NOT included):
 *   - Anthropic Claude family (would need messages-API translation)
 *   - Cohere Command family (would need /chat translation)
 *   - Voyage embeddings (would need separate endpoint shape)
 *   Plan these as separate E2.3+ work.
 */
import { prisma } from '@a2e/database'

interface ChatSeed {
  modelId: string
  inputPricePerMillionTokens: number
  outputPricePerMillionTokens: number
  metadata: Record<string, unknown>
}

const OPENAI_CHAT: ChatSeed[] = [
  {
    modelId: 'gpt-4o',
    inputPricePerMillionTokens: 2.50,
    outputPricePerMillionTokens: 10.00,
    metadata: {
      externalProvider: 'openai',
      externalModel: 'gpt-4o',
      family: 'gpt-4',
      contextWindow: 128000,
    },
  },
  {
    modelId: 'gpt-4o-mini',
    inputPricePerMillionTokens: 0.15,
    outputPricePerMillionTokens: 0.60,
    metadata: {
      externalProvider: 'openai',
      externalModel: 'gpt-4o-mini',
      family: 'gpt-4',
      contextWindow: 128000,
    },
  },
  {
    modelId: 'o3-mini',
    inputPricePerMillionTokens: 1.10,
    outputPricePerMillionTokens: 4.40,
    metadata: {
      externalProvider: 'openai',
      externalModel: 'o3-mini',
      family: 'o-series',
      contextWindow: 200000,
      // o-series reasoning models default to high effort
      reasoning: true,
    },
  },
]

const OPENAI_EMBEDDINGS: ChatSeed[] = [
  {
    modelId: 'text-embedding-3-large',
    inputPricePerMillionTokens: 0.13,
    // Embeddings return vectors not text; outputPricePerMillionTokens
    // is unused but kept non-null for schema compat.
    outputPricePerMillionTokens: 0,
    metadata: {
      externalProvider: 'openai',
      externalModel: 'text-embedding-3-large',
      family: 'embeddings',
      // 3072 default; can be reduced via Matryoshka 'dimensions' param
      defaultDimensions: 3072,
      maxDimensions: 3072,
    },
  },
  {
    modelId: 'text-embedding-ada-002',
    inputPricePerMillionTokens: 0.10,
    outputPricePerMillionTokens: 0,
    metadata: {
      externalProvider: 'openai',
      externalModel: 'text-embedding-ada-002',
      family: 'embeddings-legacy',
      defaultDimensions: 1536,
      maxDimensions: 1536,
    },
  },
]

const GROQ_CHAT: ChatSeed[] = [
  {
    modelId: 'llama-3.1-8b-instant',
    inputPricePerMillionTokens: 0.05,
    outputPricePerMillionTokens: 0.08,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'llama-3.1-8b-instant',
      externalBaseUrl: 'https://api.groq.com/openai/v1',
      externalApiKeyEnv: 'GROQ_API_KEY',
      family: 'llama-3',
      contextWindow: 131072,
    },
  },
  {
    modelId: 'mixtral-8x7b-32768',
    inputPricePerMillionTokens: 0.24,
    outputPricePerMillionTokens: 0.24,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'mixtral-8x7b-32768',
      externalBaseUrl: 'https://api.groq.com/openai/v1',
      externalApiKeyEnv: 'GROQ_API_KEY',
      family: 'mixtral',
      contextWindow: 32768,
    },
  },
  {
    modelId: 'gemma2-9b-it',
    inputPricePerMillionTokens: 0.20,
    outputPricePerMillionTokens: 0.20,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'gemma2-9b-it',
      externalBaseUrl: 'https://api.groq.com/openai/v1',
      externalApiKeyEnv: 'GROQ_API_KEY',
      family: 'gemma',
      contextWindow: 8192,
    },
  },
  {
    modelId: 'deepseek-r1-distill-llama-70b',
    inputPricePerMillionTokens: 0.75,
    outputPricePerMillionTokens: 0.99,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'deepseek-r1-distill-llama-70b',
      externalBaseUrl: 'https://api.groq.com/openai/v1',
      externalApiKeyEnv: 'GROQ_API_KEY',
      family: 'deepseek',
      contextWindow: 131072,
      reasoning: true,
    },
  },
]

const TOGETHER_CHAT: ChatSeed[] = [
  {
    modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    inputPricePerMillionTokens: 0.88,
    outputPricePerMillionTokens: 0.88,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      externalBaseUrl: 'https://api.together.xyz/v1',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      family: 'llama-3',
      contextWindow: 131072,
    },
  },
  {
    modelId: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
    inputPricePerMillionTokens: 1.20,
    outputPricePerMillionTokens: 1.20,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
      externalBaseUrl: 'https://api.together.xyz/v1',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      family: 'qwen',
      contextWindow: 32768,
    },
  },
  {
    modelId: 'deepseek-ai/DeepSeek-V3',
    inputPricePerMillionTokens: 1.25,
    outputPricePerMillionTokens: 1.25,
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'deepseek-ai/DeepSeek-V3',
      externalBaseUrl: 'https://api.together.xyz/v1',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      family: 'deepseek',
      contextWindow: 131072,
    },
  },
]

const ALL_SEEDS: ChatSeed[] = [
  ...OPENAI_CHAT,
  ...OPENAI_EMBEDDINGS,
  ...GROQ_CHAT,
  ...TOGETHER_CHAT,
]

async function main(): Promise<void> {
  let created = 0
  let updated = 0
  for (const seed of ALL_SEEDS) {
    const existing = await prisma.modelPricing.findUnique({
      where: { modelId: seed.modelId },
    })
    await prisma.modelPricing.upsert({
      where: { modelId: seed.modelId },
      create: {
        modelId: seed.modelId,
        inputPricePerMillionTokens: seed.inputPricePerMillionTokens,
        outputPricePerMillionTokens: seed.outputPricePerMillionTokens,
        isActive: true,
        metadata: seed.metadata as never,
      },
      update: {
        inputPricePerMillionTokens: seed.inputPricePerMillionTokens,
        outputPricePerMillionTokens: seed.outputPricePerMillionTokens,
        metadata: seed.metadata as never,
        isActive: true,
      },
    })
    if (existing) updated++; else created++
    console.log(`${existing ? 'updated' : 'created'}  ${seed.modelId.padEnd(48)} $${seed.inputPricePerMillionTokens.toFixed(2)} in / $${seed.outputPricePerMillionTokens.toFixed(2)} out per 1M`)
  }

  console.log()
  console.log(`Done. ${created} created, ${updated} updated.`)
  console.log()
  console.log('Required env vars to use these models:')
  console.log('  OPENAI_API_KEY     -> all openai/* models (gpt-4o, embeddings)')
  console.log('  GROQ_API_KEY       -> llama/mixtral/gemma/deepseek-r1-distill on Groq')
  console.log('  TOGETHER_API_KEY   -> Llama-3.3 / Qwen2.5 / DeepSeek-V3 on Together')
  console.log()
  console.log('Test with:')
  console.log('  curl https://a2e-api.onrender.com/v1/chat/completions \\')
  console.log('    -H "Authorization: Bearer <buyer key>" \\')
  console.log('    -H "Content-Type: application/json" \\')
  console.log('    -d \'{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}\'')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
