import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'
import {
  calculatePendingSettlements,
  createSettlement,
  markSettlementProcessing,
  markSettlementCompleted,
  markSettlementFailed,
  clearScheduledPayout,
} from '../services/settlement/engine'
import { getSolanaConfig, processPayment } from '../services/payment/solana'

const QUEUE_NAME = 'settlement-scheduler'
const RETRY_QUEUE_NAME = 'settlement-retry'

let schedulerQueue: Queue | null = null
let retryQueue: Queue | null = null

export function createSettlementSchedulerQueue(connection: ConnectionOptions): Queue {
  schedulerQueue = new Queue(QUEUE_NAME, { connection })
  return schedulerQueue
}

export function createSettlementRetryQueue(connection: ConnectionOptions): Queue {
  retryQueue = new Queue(RETRY_QUEUE_NAME, { connection })
  return retryQueue
}

export function createSettlementSchedulerWorker(
  connection: ConnectionOptions,
  prisma: PrismaClient
): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log('[SettlementScheduler] Running scheduled settlement check...')

      try {
        const config = await prisma.settlementConfig.findUnique({
          where: { id: 'default' },
        })

        if (!config?.autoSchedule) {
          console.log('[SettlementScheduler] Auto-scheduling disabled, skipping')
          return { skipped: true, reason: 'Auto-scheduling disabled' }
        }

        // Check if it's time to run based on period
        const now = new Date()
        const shouldRun = checkIfShouldRun(config, now)

        if (!shouldRun) {
          console.log('[SettlementScheduler] Not scheduled to run at this time')
          return { skipped: true, reason: 'Not scheduled time' }
        }

        // Calculate pending settlements
        const settlements = await calculatePendingSettlements(prisma, now)
        console.log(`[SettlementScheduler] Found ${settlements.length} pending settlements`)

        if (settlements.length === 0) {
          await prisma.settlementConfig.update({
            where: { id: 'default' },
            data: { lastScheduledAt: now },
          })
          return { processed: 0, reason: 'No pending settlements' }
        }

        // Get Solana config for payments
        const solanaConfig = await getSolanaConfig(prisma)

        let processed = 0
        let failed = 0

        for (const calc of settlements) {
          try {
            // Create settlement record
            const settlementId = await createSettlement(prisma, calc)
            // Atomic claim. Skipping if false means another scheduler
            // tick (or operator manual /process) already grabbed this
            // newly-created settlement before us. Race window is tiny
            // (one Postgres roundtrip) but possible under concurrency.
            const claimed = await markSettlementProcessing(prisma, settlementId)
            if (!claimed) {
              console.log(`[SettlementScheduler] Settlement ${settlementId} already claimed by another worker; skipping`)
              continue
            }

            // Process payment
            const result = await processPayment(
              solanaConfig,
              calc.walletAddress,
              calc.amount,
              'USDC'
            )

            if (result.success && result.txHash) {
              await markSettlementCompleted(prisma, settlementId, result.txHash)

              // Payout-mode follow-ups: if this was a SCHEDULED fire,
              // flip the operator back to AUTO. If it was a forced
              // sweep (cap / inactivity), log a clear reason so admins
              // can see why a hold operator just received funds.
              if (calc.isScheduledFire && calc.nodeRunnerId) {
                await clearScheduledPayout(prisma, calc.nodeRunnerId)
                console.log(
                  `[SettlementScheduler] Settlement ${settlementId} fulfilled SCHEDULED payout; operator ${calc.nodeRunnerId} reset to AUTO`
                )
              } else if (calc.forceReason) {
                console.log(
                  `[SettlementScheduler] Settlement ${settlementId} fired despite hold (reason: ${calc.forceReason})`
                )
              }

              processed++
              console.log(
                `[SettlementScheduler] Settlement ${settlementId} completed: ${result.txHash}`
              )
            } else {
              await markSettlementFailed(prisma, settlementId, result.error ?? 'Payment failed')
              failed++

              // Queue for retry
              if (retryQueue) {
                await retryQueue.add(
                  'retry',
                  { settlementId },
                  { delay: 60000 } // First retry after 1 minute
                )
              }
            }
          } catch (error) {
            console.error('[SettlementScheduler] Error processing settlement:', error)
            failed++
          }
        }

        // Update last scheduled time
        await prisma.settlementConfig.update({
          where: { id: 'default' },
          data: { lastScheduledAt: now },
        })

        console.log(
          `[SettlementScheduler] Completed: ${processed} processed, ${failed} failed`
        )

        return { processed, failed, total: settlements.length }
      } catch (error) {
        console.error('[SettlementScheduler] Error:', error)
        throw error
      }
    },
    { connection }
  )
}

export function createSettlementRetryWorker(
  connection: ConnectionOptions,
  prisma: PrismaClient
): Worker {
  return new Worker(
    RETRY_QUEUE_NAME,
    async (job) => {
      const { settlementId } = job.data
      console.log(`[SettlementRetry] Retrying settlement ${settlementId}...`)

      try {
        const settlement = await prisma.settlement.findUnique({
          where: { id: settlementId },
        })

        if (!settlement) {
          console.log(`[SettlementRetry] Settlement ${settlementId} not found`)
          return { error: 'Settlement not found' }
        }

        // Check if already completed
        if (settlement.status === 'COMPLETED') {
          console.log(`[SettlementRetry] Settlement ${settlementId} already completed`)
          return { skipped: true, reason: 'Already completed' }
        }

        // Check retry count
        if (settlement.retryCount >= settlement.maxRetries) {
          console.log(
            `[SettlementRetry] Settlement ${settlementId} exceeded max retries (${settlement.maxRetries})`
          )
          return { error: 'Max retries exceeded' }
        }

        // SECURITY (2026-06-11 fourth-round audit): atomic claim before
        // touching processPayment. Two retry jobs for the same
        // settlement (BullMQ duplicate enqueue, manual + auto-retry
        // overlap, etc.) would otherwise both pass the status check
        // and both fire treasury USDC. Only one wins the FAILED ->
        // PROCESSING flip; the other sees count === 0 and returns
        // early.
        const claimed = await prisma.settlement.updateMany({
          where: {
            id: settlementId,
            status: { in: ['FAILED', 'PENDING'] },
            retryCount: { lt: settlement.maxRetries },
          },
          data: {
            retryCount: settlement.retryCount + 1,
            lastRetryAt: new Date(),
            status: 'PROCESSING',
          },
        })
        if (claimed.count === 0) {
          console.log(`[SettlementRetry] Settlement ${settlementId} could not be claimed (already processing or claimed by another retry)`)
          return { skipped: true, reason: 'Could not claim' }
        }

        // Get Solana config
        const solanaConfig = await getSolanaConfig(prisma)

        // Retry payment
        const result = await processPayment(
          solanaConfig,
          settlement.walletAddress,
          settlement.amount,
          'USDC'
        )

        if (result.success && result.txHash) {
          await markSettlementCompleted(prisma, settlementId, result.txHash)
          console.log(`[SettlementRetry] Settlement ${settlementId} succeeded on retry`)
          return { success: true, txHash: result.txHash }
        } else {
          const newRetryCount = settlement.retryCount + 1

          if (newRetryCount >= settlement.maxRetries) {
            await markSettlementFailed(
              prisma,
              settlementId,
              `Failed after ${newRetryCount} attempts: ${result.error}`
            )
            console.log(`[SettlementRetry] Settlement ${settlementId} failed permanently`)
          } else {
            // Schedule next retry with exponential backoff
            const delay = Math.pow(2, newRetryCount) * 60000 // 2^n minutes
            const nextRetryAt = new Date(Date.now() + delay)

            await prisma.settlement.update({
              where: { id: settlementId },
              data: {
                status: 'FAILED',
                errorMessage: result.error,
                nextRetryAt,
              },
            })

            if (retryQueue) {
              await retryQueue.add('retry', { settlementId }, { delay })
              console.log(
                `[SettlementRetry] Settlement ${settlementId} scheduled for retry in ${delay / 60000} minutes`
              )
            }
          }

          return { error: result.error, retryCount: newRetryCount }
        }
      } catch (error) {
        console.error('[SettlementRetry] Error:', error)
        throw error
      }
    },
    { connection }
  )
}

function checkIfShouldRun(
  config: {
    period: string
    dayOfWeek: number | null
    dayOfMonth: number | null
    hour: number
    lastScheduledAt: Date | null
  },
  now: Date
): boolean {
  const currentHour = now.getHours()
  const currentDayOfWeek = now.getDay()
  const currentDayOfMonth = now.getDate()

  // Check if we're in the right hour
  if (currentHour !== config.hour) {
    return false
  }

  // Check if we already ran today
  if (config.lastScheduledAt) {
    const lastRun = new Date(config.lastScheduledAt)
    if (
      lastRun.getFullYear() === now.getFullYear() &&
      lastRun.getMonth() === now.getMonth() &&
      lastRun.getDate() === now.getDate()
    ) {
      return false // Already ran today
    }
  }

  switch (config.period) {
    case 'DAILY':
      return true

    case 'WEEKLY':
      // Check if it's the right day of week
      return currentDayOfWeek === (config.dayOfWeek ?? 1)

    case 'MONTHLY':
      // Check if it's the right day of month
      return currentDayOfMonth === (config.dayOfMonth ?? 1)

    default:
      return false
  }
}

export async function scheduleSettlementChecker(
  intervalMinutes: number = 60
): Promise<void> {
  if (!schedulerQueue) {
    console.warn('[SettlementScheduler] Queue not initialized')
    return
  }

  // Remove existing repeatable jobs
  const existingJobs = await schedulerQueue.getRepeatableJobs()
  for (const job of existingJobs) {
    await schedulerQueue.removeRepeatableByKey(job.key)
  }

  // Add new repeatable job - check every hour
  await schedulerQueue.add(
    'check-settlements',
    {},
    {
      repeat: {
        every: intervalMinutes * 60 * 1000,
      },
    }
  )

  console.log(`[SettlementScheduler] Scheduled to check every ${intervalMinutes} minutes`)
}

export async function triggerSettlementCheck(): Promise<void> {
  if (!schedulerQueue) {
    throw new Error('Settlement scheduler queue not initialized')
  }

  await schedulerQueue.add('manual-check', {}, { priority: 1 })
  console.log('[SettlementScheduler] Manual check triggered')
}

export async function retryFailedSettlements(prisma: PrismaClient): Promise<number> {
  if (!retryQueue) {
    throw new Error('Settlement retry queue not initialized')
  }

  // Find failed settlements that can be retried
  const failedSettlements = await prisma.settlement.findMany({
    where: {
      status: 'FAILED',
      retryCount: { lt: prisma.settlement.fields.maxRetries },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
  })

  for (const settlement of failedSettlements) {
    await retryQueue.add('retry', { settlementId: settlement.id }, { priority: 1 })
  }

  console.log(`[SettlementScheduler] Queued ${failedSettlements.length} settlements for retry`)
  return failedSettlements.length
}
