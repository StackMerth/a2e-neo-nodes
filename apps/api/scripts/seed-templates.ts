/**
 * Seed the default template catalog (M2 / B2).
 *
 * Idempotent — upserts by `slug`. Safe to run on any DB at any time;
 * this script never deletes templates an admin has added by hand.
 *
 * Run:   pnpm --filter @a2e/api seed:templates
 *
 * Unlike seed-test-data.ts, this is intentionally allowed in production
 * because the catalog needs to exist on the live DB for the buyer
 * portal to show anything. Each entry is a real, stable Docker image.
 */
import { prisma } from '@a2e/database'

interface TemplateSeed {
  slug: string
  name: string
  description: string
  dockerImage: string
  defaultPort?: number
  exposedPorts: number[]
  envVars?: Record<string, string>
  startupCommand?: string
  category: string
  iconUrl?: string
}

const TEMPLATES: TemplateSeed[] = [
  {
    slug: 'pytorch-cuda12-jupyter',
    name: 'PyTorch + CUDA 12.1 + Jupyter',
    description:
      'PyTorch 2.3 with CUDA 12.1 and Jupyter Lab. The default for training, fine-tuning, and notebook work.',
    dockerImage: 'pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime',
    defaultPort: 8888,
    exposedPorts: [8888, 22],
    startupCommand: 'jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --allow-root',
    category: 'training',
  },
  {
    slug: 'tensorflow-cuda12-jupyter',
    name: 'TensorFlow + CUDA 12 + Jupyter',
    description:
      'TensorFlow 2.16 with CUDA 12 and Jupyter Lab. For Keras workflows and TF-native projects.',
    dockerImage: 'tensorflow/tensorflow:2.16.1-gpu-jupyter',
    defaultPort: 8888,
    exposedPorts: [8888],
    startupCommand: 'jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --allow-root',
    category: 'training',
  },
  {
    slug: 'vllm-inference',
    name: 'vLLM Inference Server',
    description:
      'vLLM OpenAI-compatible inference server. Pass MODEL env to choose which HuggingFace model to serve.',
    dockerImage: 'vllm/vllm-openai:latest',
    defaultPort: 8000,
    exposedPorts: [8000],
    envVars: { MODEL: 'meta-llama/Llama-3-8B-Instruct' },
    startupCommand: '--model $MODEL --host 0.0.0.0 --port 8000',
    category: 'inference',
  },
  {
    slug: 'comfyui-sd',
    name: 'ComfyUI (Stable Diffusion)',
    description:
      'ComfyUI for Stable Diffusion image generation. Web UI on port 8188.',
    dockerImage: 'yanwk/comfyui-boot:latest',
    defaultPort: 8188,
    exposedPorts: [8188],
    category: 'inference',
  },
  {
    slug: 'whisper-streaming',
    name: 'Whisper Streaming Transcription',
    description:
      'Faster-Whisper server for real-time speech-to-text. WebSocket on 9090.',
    dockerImage: 'collabora/whisperlive:latest',
    defaultPort: 9090,
    exposedPorts: [9090],
    category: 'inference',
  },
  {
    slug: 'axolotl-finetune',
    name: 'Axolotl Fine-tuning',
    description:
      'Axolotl LLM fine-tuning environment. Pre-loaded with QLoRA, LoRA, and full-finetune configs.',
    dockerImage: 'winglian/axolotl:main-latest',
    exposedPorts: [22],
    category: 'training',
  },
  {
    slug: 'blank-cuda',
    name: 'Blank CUDA 12.1',
    description:
      'Minimal Ubuntu 22.04 with CUDA 12.1 toolkit and SSH. Build whatever you want from scratch.',
    dockerImage: 'nvidia/cuda:12.1.1-devel-ubuntu22.04',
    exposedPorts: [22],
    category: 'blank',
  },
]

async function main() {
  console.log(`Seeding ${TEMPLATES.length} templates...`)
  for (const t of TEMPLATES) {
    const existing = await prisma.template.findUnique({ where: { slug: t.slug } })
    if (existing) {
      // Refresh metadata but preserve admin-tuned popularity counter.
      await prisma.template.update({
        where: { slug: t.slug },
        data: {
          name: t.name,
          description: t.description,
          dockerImage: t.dockerImage,
          defaultPort: t.defaultPort,
          exposedPorts: t.exposedPorts,
          envVars: t.envVars,
          startupCommand: t.startupCommand,
          category: t.category,
          iconUrl: t.iconUrl,
          isActive: true,
        },
      })
      console.log(`  updated  ${t.slug}`)
    } else {
      await prisma.template.create({
        data: {
          slug: t.slug,
          name: t.name,
          description: t.description,
          dockerImage: t.dockerImage,
          defaultPort: t.defaultPort,
          exposedPorts: t.exposedPorts,
          envVars: t.envVars,
          startupCommand: t.startupCommand,
          category: t.category,
          iconUrl: t.iconUrl,
        },
      })
      console.log(`  created  ${t.slug}`)
    }
  }
  console.log('Done.')
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
