/**
 * Track 5 / E3.3 — seed Whisper-family audio-transcription models.
 *
 * Per-second billing lives on ModelPricing.metadata.audioPricing
 * as { perSecondUsd: 0.0001 }. The route looks up that field and
 * 400s with "not_audio_model" if it's missing.
 *
 *   pnpm --filter @a2e/api seed:audio-models
 *
 * Re-runnable. Upsert keyed on modelId; existing rows have metadata
 * + isActive overwritten, per-token prices stay zero (audio bills via
 * audioPricing.perSecondUsd, not per-token).
 */
import { prisma } from '@a2e/database'

interface AudioSeed {
  modelId: string
  metadata: Record<string, unknown>
}

const SEEDS: AudioSeed[] = [
  {
    modelId: 'whisper-1',
    metadata: {
      externalProvider: 'openai',
      externalModel: 'whisper-1',
      // OpenAI Whisper pricing as of 2026-06: $0.006/min = $0.0001/sec.
      audioPricing: { perSecondUsd: 0.0001 },
    },
  },
  {
    // OpenAI's newer transcription endpoint (same Whisper backend).
    modelId: 'gpt-4o-mini-transcribe',
    metadata: {
      externalProvider: 'openai',
      externalModel: 'gpt-4o-mini-transcribe',
      // $0.003/min = $0.00005/sec (per OpenAI's published rate).
      audioPricing: { perSecondUsd: 0.00005 },
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
  console.log('  curl https://a2e-api.onrender.com/v1/audio/transcriptions \\')
  console.log('    -H "Authorization: Bearer <buyer key>" \\')
  console.log('    -F file=@/path/to/audio.mp3 \\')
  console.log('    -F model=whisper-1')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
