import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import { runReconciliation, getReconciliationStatus } from '../services/reconciliation/reconciler'

const QUEUE_NAME = 'reconciliation-scheduler'

export function createReconciliationQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  })
}

export function createReconciliationWorker(
  connection: ConnectionOptions,
  prisma: PrismaClient
): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[Reconciliation] Running reconciliation check...`)

      try {
        const result = await runReconciliation(prisma)

        console.log(
          `[Reconciliation] Completed: processed=${result.processed}, ` +
            `verified=${result.verified}, failed=${result.failed}, notFound=${result.notFound}`
        )

        if (result.errors.length > 0) {
          console.warn(`[Reconciliation] Errors:`, result.errors)
        }

        // Get status summary
        const status = await getReconciliationStatus(prisma)
        console.log(`[Reconciliation] Status: pending=${status.pending}, orphaned=${status.orphanedPayments}`)

        return {
          result,
          status,
        }
      } catch (error) {
        console.error('[Reconciliation] Error:', error)
        throw error
      }
    },
    { connection }
  )

  worker.on('failed', (job, err) => {
    console.error(`[Reconciliation] Job ${job?.id} failed:`, err)
  })

  return worker
}

/**
 * Schedule reconciliation to run every 5 minutes
 */
export async function scheduleReconciliation(queue: Queue, intervalMinutes = 5): Promise<void> {
  // Remove existing repeatable jobs
  const existingJobs = await queue.getRepeatableJobs()
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key)
  }

  // Add new repeatable job
  await queue.add(
    'reconciliation-check',
    { scheduledAt: new Date().toISOString() },
    {
      repeat: {
        every: intervalMinutes * 60 * 1000,
      },
    }
  )

  console.log(`[Reconciliation] Scheduled to run every ${intervalMinutes} minutes`)
}
