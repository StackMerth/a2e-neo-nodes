/**
 * Track 5 / E3.2 — seed image-generation models into ModelPricing.
 *
 * Per-image billing lives on ModelPricing.metadata.imagePricing as a
 * map of "<quality>:<width>x<height>" -> USD-per-image. The route
 * looks up by that exact key (or falls back to "default:<size>" for
 * open-source models that don't have standard/hd tiers).
 *
 * Currently seeds:
 *   - dall-e-3   (OpenAI)         — standard/hd, three sizes each
 *   - dall-e-2   (OpenAI)         — square sizes only
 *   - black-forest-labs/FLUX.1-schnell (Together AI fallback)
 *
 * Run from a node with API DATABASE_URL pointed at production:
 *   pnpm --filter @a2e/api seed:image-models
 *
 * Re-runnable. Upsert keyed on modelId; existing rows have metadata
 * + isActive overwritten, prices kept zero (image models bill via
 * imagePricing, not per-token).
 */
import { prisma } from '@a2e/database'

interface ImageSeed {
  modelId: string
  metadata: Record<string, unknown>
}

const SEEDS: ImageSeed[] = [
  {
    modelId: 'dall-e-3',
    metadata: {
      externalProvider: 'openai',
      externalModel: 'dall-e-3',
      // OpenAI prices, as of 2026-06: standard $0.040-$0.080, hd $0.080-$0.120.
      imagePricing: {
        'standard:1024x1024': 0.04,
        'standard:1024x1792': 0.08,
        'standard:1792x1024': 0.08,
        'hd:1024x1024': 0.08,
        'hd:1024x1792': 0.12,
        'hd:1792x1024': 0.12,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'standard',
    },
  },
  {
    modelId: 'dall-e-2',
    metadata: {
      externalProvider: 'openai',
      externalModel: 'dall-e-2',
      // DALL-E 2 has only "standard" quality.
      imagePricing: {
        'standard:1024x1024': 0.02,
        'standard:512x512': 0.018,
        'standard:256x256': 0.016,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'standard',
    },
  },
  {
    // Open-source fallback via Together AI. Uses "default:<size>"
    // key prefix since the model has no standard/hd tier.
    modelId: 'black-forest-labs/FLUX.1-schnell',
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'black-forest-labs/FLUX.1-schnell',
      externalBaseUrlEnv: 'TOGETHER_BASE_URL',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      imagePricing: {
        'default:1024x1024': 0.0027,
        'default:512x512': 0.0014,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'default',
    },
  },
]

async function main(): Promise<void> {
  for (const seed of SEEDS) {
    await prisma.modelPricing.upsert({
      where: { modelId: seed.modelId },
      create: {
        modelId: seed.modelId,
        inputPricePerMillionTokens: 0,
        outputPricePerMillionTokens: 0,
        isActive: true,
        metadata: seed.metadata as never,
      },
      update: {
        metadata: seed.metadata as never,
        isActive: true,
      },
    })
    console.log(`seeded ${seed.modelId}`)
  }

  console.log()
  console.log('Done. Test with:')
  console.log('  curl https://a2e-api.onrender.com/v1/images/generations \\')
  console.log('    -H "Authorization: Bearer <buyer key>" \\')
  console.log('    -H "Content-Type: application/json" \\')
  console.log('    -d \'{"model":"dall-e-3","prompt":"A cat","size":"1024x1024","n":1}\'')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
