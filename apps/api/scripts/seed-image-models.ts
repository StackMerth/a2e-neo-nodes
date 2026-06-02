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
    // OpenAI's CURRENT flagship image model. Replaced DALL-E line in
    // 2025 — most newer accounts have access to this and NOT to
    // dall-e-3/dall-e-2 (which OpenAI didn't grandfather forward).
    // Higher quality and better prompt adherence than DALL-E 3.
    //
    // Quality tiers (high/medium/low) replace DALL-E's standard/hd.
    // Sizes: 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait),
    // 'auto' lets the model pick. We seed the three explicit sizes.
    modelId: 'gpt-image-1',
    metadata: {
      externalProvider: 'openai',
      externalModel: 'gpt-image-1',
      // OpenAI gpt-image-1 published prices as of 2026-06.
      imagePricing: {
        'low:1024x1024': 0.011,
        'low:1024x1536': 0.016,
        'low:1536x1024': 0.016,
        'medium:1024x1024': 0.042,
        'medium:1024x1536': 0.063,
        'medium:1536x1024': 0.063,
        'high:1024x1024': 0.167,
        'high:1024x1536': 0.25,
        'high:1536x1024': 0.25,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'medium',
    },
  },
  {
    // OpenAI's cheap variant. ~4x cheaper than gpt-image-1 with
    // somewhat lower quality. Good default for high-volume use cases
    // where each image's quality isn't critical (chatbot avatars,
    // batch placeholders, draft iterations).
    modelId: 'gpt-image-1-mini',
    metadata: {
      externalProvider: 'openai',
      externalModel: 'gpt-image-1-mini',
      imagePricing: {
        'low:1024x1024': 0.005,
        'low:1024x1536': 0.0075,
        'low:1536x1024': 0.0075,
        'medium:1024x1024': 0.011,
        'medium:1024x1536': 0.016,
        'medium:1536x1024': 0.016,
        'high:1024x1024': 0.042,
        'high:1024x1536': 0.063,
        'high:1536x1024': 0.063,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'medium',
    },
  },
  {
    // Legacy. OpenAI DEPRECATED DALL-E 3 and 2 — newer accounts won't
    // have access. We keep these seeded for backward compatibility
    // with any buyer who has DALL-E access from an older account.
    // The platform returns OpenAI's "model does not exist" upstream
    // error cleanly when the buyer doesn't have access.
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
      externalBaseUrl: 'https://api.together.xyz/v1',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      imagePricing: {
        'default:1024x1024': 0.0027,
        'default:512x512': 0.0014,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'default',
    },
  },
  {
    // Higher-quality FLUX variant via Together AI. ~10x the cost of
    // FLUX-schnell but significantly better output quality.
    modelId: 'black-forest-labs/FLUX.1-dev',
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'black-forest-labs/FLUX.1-dev',
      externalBaseUrl: 'https://api.together.xyz/v1',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      imagePricing: {
        'default:1024x1024': 0.0275,
        'default:512x512': 0.0145,
      },
      defaultSize: '1024x1024',
      defaultQuality: 'default',
    },
  },
  {
    // SDXL base, the workhorse open-source image model. Cheap and
    // widely understood. Use for buyers who want SDXL specifically
    // (e.g. existing pipelines that fine-tuned on SDXL outputs).
    modelId: 'stabilityai/stable-diffusion-xl-base-1.0',
    metadata: {
      externalProvider: 'openai-compat',
      externalModel: 'stabilityai/stable-diffusion-xl-base-1.0',
      externalBaseUrl: 'https://api.together.xyz/v1',
      externalApiKeyEnv: 'TOGETHER_API_KEY',
      imagePricing: {
        'default:1024x1024': 0.0067,
        'default:512x512': 0.0035,
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
