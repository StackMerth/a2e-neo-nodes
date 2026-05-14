/**
 * Launch-blocker #2 — SSH session reaper.
 *
 * Failsafe for the agent-side cleanup loop. After a rental ends the
 * ComputeRequest moves to status=COMPLETED + sshSessionStatus=TERMINATING.
 * The agent normally picks that up on its next heartbeat (within ~30s),
 * runs userdel, and reports TERMINATED — which is what finally nulls
 * Node.assignedComputeRequestId and returns the node to the idle pool.
 *
 * If the agent is offline / has crashed / lost network, the node would
 * otherwise stay "stuck" on the dead rental forever. This worker scans
 * for those stuck rows and force-releases them:
 *   - sshSessionStatus -> TERMINATED (with sshErrorMessage)
 *   - Node.assignedComputeRequestId -> null
 *
 * Latency tradeoff: rentals stay attached to nodes for up to
 * STUCK_THRESHOLD_MS (default 10 min) past completedAt before the
 * reaper steps in. That's the worst-case the operator's inventory
 * sits idle waiting for an offline agent. The happy path is dominated
 * by the heartbeat interval (~30s) so this only matters when something
 * has gone wrong.
 */

import { Queue, Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { PrismaClient } from '@a2e/database'

const QUEUE_NAME = 'ssh-session-reaper'
const TICK_INTERVAL_MS = parseInt(process.env.SSH_REAPER_TICK_MS ?? '60000', 10)
const STUCK_THRESHOLD_MS = parseInt(process.env.SSH_REAPER_STUCK_THRESHOLD_MS ?? '600000', 10) // 10 min
const BATCH_SIZE = 100

interface ReaperDeps {
  redis: ConnectionOptions
  prisma: PrismaClient
}

export function createSshSessionReaperQueue(connection: ConnectionOptions): Queue {
  return new Queue(QUEUE_NAME, { connection })
}

export function createSshSessionReaperWorker({ redis, prisma }: ReaperDeps): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS)

      const stuck = await prisma.computeRequest.findMany({
        where: {
          status: 'COMPLETED',
          sshSessionStatus: 'TERMINATING',
          completedAt: { lt: threshold, not: null },
        },
        select: { id: true, allocatedNodeIds: true, completedAt: true },
        take: BATCH_SIZE,
      })

      if (stuck.length === 0) return

      // eslint-disable-next-line no-console
      console.log(
        `[ssh-reaper] force-releasing ${stuck.length} stuck SSH session${stuck.length === 1 ? '' : 's'}`
      )

      for (const cr of stuck) {
        const ageMin = cr.completedAt
          ? Math.round((Date.now() - cr.completedAt.getTime()) / 60000)
          : 0
        try {
          await prisma.$transaction(async (tx) => {
            await tx.computeRequest.update({
              where: { id: cr.id },
              data: {
                sshSessionStatus: 'TERMINATED',
                sshTerminatedAt: new Date(),
                sshErrorMessage: `force-released by reaper after ${ageMin}m without agent confirmation`,
              },
            })
            if (cr.allocatedNodeIds.length > 0) {
              await tx.node.updateMany({
                where: { id: { in: cr.allocatedNodeIds } },
                data: { assignedComputeRequestId: null },
              })
            }
          })
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[ssh-reaper] failed to reap ${cr.id}:`, err)
        }
      }
    },
    { connection: redis }
  )

  // Periodic trigger via repeatable job.
  void worker.waitUntilReady().then(async () => {
    const queue = createSshSessionReaperQueue(redis)
    await queue.add(
      'tick',
      {},
      {
        repeat: { every: TICK_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: true,
      }
    )
  })

  return worker
}
