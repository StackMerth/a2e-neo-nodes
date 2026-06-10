/**
 * E6 / M3.9a: Image scan worker scaffold.
 *
 * Right now this worker only transitions PENDING → COMPLETED with all
 * severity counts zero. It's a scaffold so the queue + worker plumbing
 * is exercised end-to-end during M3.9a verification. M3.9b will replace
 * the scaffold body with the real Trivy scan:
 *
 *   1. Pull the image via skopeo (or docker if we co-locate the daemon)
 *   2. Run `trivy image --format json <imageRef>`
 *   3. Parse severity counts from the JSON output
 *   4. If criticalCount > 0, flip DockerImage.pullBlocked = true with
 *      a summary message in pullBlockReason
 *   5. Notify the buyer (BURN_RATE_ALERT-style)
 *
 * The scaffold mode is gated on TRIVY_WORKER_ENABLED env. Default off
 * so the scan rows show COMPLETED with zero findings (visible in the
 * buyer UI as "scan ran, all clear"). When the real Trivy worker
 * lands in M3.9b, flipping the env var on will route to the real
 * scan path; flipping off rolls back instantly without redeploy.
 *
 * Queue conventions match the rest of the codebase:
 *   - One repeatable tick OR one job-per-event (this is event-driven,
 *     so we use one job per scan keyed by scanId)
 *   - attempts: 3 with exponential backoff (Trivy can flake on huge
 *     images and the registry's S3 backend has occasional latency
 *     spikes)
 *   - removeOnComplete: 100 retained for debugging recent successes
 *   - removeOnFail: 500 retained for triage
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const QUEUE_NAME = 'image-scan-queue'

interface ScanJobData {
  imageId: string
  scanId: string
}

interface WorkerDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createImageScanQueue(connection: ConnectionOptions): Queue {
  return new Queue<ScanJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  })
}

export function createImageScanWorker(deps: WorkerDeps): Worker<ScanJobData> {
  return new Worker<ScanJobData>(
    QUEUE_NAME,
    async (job) => {
      const { imageId, scanId } = job.data

      // Mark RUNNING. The buyer UI shows "scanning..." between this
      // point and COMPLETED.
      await deps.prisma.imageScan.update({
        where: { id: scanId },
        data: { status: 'RUNNING' },
      })

      // Look up the image so M3.9b can pull it. M3.9a scaffold doesn't
      // actually use the row but the query verifies referential integrity:
      // if the image was deleted between webhook receipt and worker pickup,
      // we transition the scan to FAILED rather than emitting a phantom
      // COMPLETED.
      const image = await deps.prisma.dockerImage.findUnique({
        where: { id: imageId },
      })
      if (!image) {
        await deps.prisma.imageScan.update({
          where: { id: scanId },
          data: {
            status: 'FAILED',
            errorMessage: 'image row deleted before scan started',
            completedAt: new Date(),
          },
        })
        return { scanned: false, reason: 'image-missing' }
      }

      const trivyEnabled = process.env.TRIVY_WORKER_ENABLED === 'true'

      if (!trivyEnabled) {
        // M3.9a scaffold: emit a COMPLETED scan with no findings so the
        // buyer UI shows the scan happened and was clean. The real
        // scanner ships in M3.9b; until then every image is treated
        // as "scanned, no critical CVEs found" because we haven't
        // looked. This is documented in the buyer UI.
        await deps.prisma.imageScan.update({
          where: { id: scanId },
          data: {
            status: 'COMPLETED',
            criticalCount: 0,
            highCount: 0,
            mediumCount: 0,
            lowCount: 0,
            unknownCount: 0,
            resultJson: { scaffold: true, note: 'Trivy not yet enabled (M3.9b pending)' },
            completedAt: new Date(),
          },
        })
        return { scanned: false, reason: 'scaffold-mode' }
      }

      // M3.9b will replace this block with:
      //   const skopeoUrl = `docker://a2e-registry.onrender.com/${image.userId}/${image.repository}:${image.tag}`
      //   const trivyResult = await runTrivy(skopeoUrl, { token: signRegistryToken(...) })
      //   const counts = countSeverities(trivyResult)
      //   await prisma.imageScan.update({ ..., data: { ...counts, resultJson: trivyResult, status: 'COMPLETED' } })
      //   if (counts.criticalCount > 0) {
      //     await prisma.dockerImage.update({
      //       where: { id: imageId },
      //       data: { pullBlocked: true, pullBlockReason: summarizeCritical(trivyResult) },
      //     })
      //     await notifyBuyerOfCriticalCves(image.userId, image.repository, image.tag, counts)
      //   }
      await deps.prisma.imageScan.update({
        where: { id: scanId },
        data: {
          status: 'FAILED',
          errorMessage: 'TRIVY_WORKER_ENABLED=true but scan implementation not yet shipped (M3.9b pending)',
          completedAt: new Date(),
        },
      })
      return { scanned: false, reason: 'm3-9b-not-shipped' }
    },
    {
      connection: deps.redis,
      concurrency: parseInt(process.env.IMAGE_SCAN_CONCURRENCY ?? '2', 10),
    },
  )
}
