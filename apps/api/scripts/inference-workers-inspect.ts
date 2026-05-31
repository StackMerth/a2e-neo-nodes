/**
 * E2.1 — inference worker inspector.
 *
 * Lists every InferenceWorker row with operator, models, status,
 * heartbeat freshness, and current inflight load. Useful for verifying
 * the registration + heartbeat endpoints work after E2.1 ships.
 *
 * Modes:
 *
 *   pnpm --filter @a2e/api inference-workers:inspect
 *     -> default: list every worker with operator + status + freshness
 *
 *   pnpm --filter @a2e/api inference-workers:inspect --route <model>
 *     -> dry-run the router for a given model id; prints which worker
 *        would be picked (or "no eligible worker"). Pure read-only.
 */
import { prisma } from '@a2e/database'
import { pickInferenceWorker } from '../src/services/inference/router.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const routeFlag = args.indexOf('--route')
  if (routeFlag >= 0) {
    const model = args[routeFlag + 1]
    if (!model) {
      console.log('--route requires a model id, e.g. --route gpt-4o')
      process.exit(1)
    }
    await runRouter(model)
    return
  }
  await runList()
}

async function runList(): Promise<void> {
  const workers = await prisma.inferenceWorker.findMany({
    orderBy: { lastHeartbeat: 'desc' },
    include: {
      node: {
        select: {
          id: true,
          gpuTier: true,
          region: true,
          nodeRunner: { select: { id: true, name: true } },
        },
      },
      _count: {
        select: {
          inferenceRequests: {
            where: { status: { in: ['ROUTING', 'STREAMING'] } },
          },
        },
      },
    },
  })

  if (workers.length === 0) {
    console.log('No InferenceWorker rows in the DB.')
    console.log()
    console.log('Register a worker via:')
    console.log('  POST /v1/inference-workers/register  (operator JWT auth)')
    console.log('Body:')
    console.log(JSON.stringify({
      nodeId: '<your node id>',
      servedModels: ['gpt-4o', 'llama-3.1-70b-instruct'],
      baseUrl: 'http://your-worker.example/v1/',
      capacity: 4,
    }, null, 2))
    return
  }

  console.log(`InferenceWorker rows (${workers.length}):`)
  console.log()
  console.log(`  ${'id'.padEnd(28)} ${'status'.padEnd(9)} ${'tier'.padEnd(6)} ${'load'.padEnd(6)} ${'p50'.padEnd(8)} ${'heartbeat'.padEnd(22)} models`)
  for (const w of workers) {
    const age = Math.floor((Date.now() - w.lastHeartbeat.getTime()) / 1000)
    const fresh = age < 90 ? `${age}s` : `${age}s STALE`
    const load = `${w._count.inferenceRequests}/${w.capacity}`
    const p50 = w.p50LatencyMs ? `${w.p50LatencyMs}ms` : '(n/a)'
    const models = w.servedModels.split(',').map((s) => s.trim()).slice(0, 3).join(', ')
    const moreModels = w.servedModels.split(',').length > 3 ? ` +${w.servedModels.split(',').length - 3} more` : ''
    console.log(
      `  ${w.id.padEnd(28)} ${w.status.padEnd(9)} ${w.node.gpuTier.padEnd(6)} ${load.padEnd(6)} ${p50.padEnd(8)} ${fresh.padEnd(22)} ${models}${moreModels}`,
    )
    if (w.node.nodeRunner) {
      console.log(`    operator: ${w.node.nodeRunner.name} (${w.node.nodeRunner.id})`)
    } else {
      console.log(`    operator: (no nodeRunner on Node ${w.nodeId})`)
    }
  }
  console.log()
  console.log('Dry-run the router for a specific model:')
  console.log('  pnpm --filter @a2e/api inference-workers:inspect --route <model-id>')
}

async function runRouter(model: string): Promise<void> {
  console.log(`Routing test: pickInferenceWorker({ model: "${model}" })`)
  console.log()
  const result = await pickInferenceWorker(prisma, { model })
  if (!result) {
    console.log('No eligible worker. Reasons (any of):')
    console.log('  - No worker has this model in its servedModels list')
    console.log('  - All workers serving this model are STALE (heartbeat >90s old)')
    console.log('  - All workers serving this model are at capacity')
    console.log('  - No workers are in READY or SERVING status')
    return
  }
  console.log('Selected worker:')
  console.log(`  id:            ${result.id}`)
  console.log(`  nodeId:        ${result.nodeId}`)
  console.log(`  baseUrl:       ${result.baseUrl}`)
  console.log(`  capacity:      ${result.currentInflight}/${result.capacity}`)
  console.log(`  p50 latency:   ${result.p50LatencyMs ?? '(n/a)'}ms`)
  console.log(`  reputation:    ${result.reputationScore ?? '(none)'}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
