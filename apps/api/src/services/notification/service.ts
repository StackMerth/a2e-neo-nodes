import { prisma } from '@a2e/database'
import type { NotificationType } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'

/** WebSocket server reference — set during server startup */
let io: SocketServer | null = null

/** Set the Socket.io server reference for real-time notification push */
export function setNotificationSocket(server: SocketServer) {
  io = server
}

/**
 * Create a notification for a user and emit via WebSocket
 */
export async function createNotification(
  userId: string,
  type: NotificationType,
  title: string,
  message: string,
) {
  const notification = await prisma.notification.create({
    data: { userId, type, title, message },
  })

  // Push real-time notification via WebSocket
  io?.emit('notification:new', {
    userId,
    id: notification.id,
    type,
    title,
    message,
  })

  return notification
}

/**
 * Find the user ID for a node runner (by nodeRunnerId)
 */
async function findUserIdForNodeRunner(nodeRunnerId: string): Promise<string | null> {
  const nr = await prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: { userId: true },
  })
  return nr?.userId ?? null
}

/**
 * Find the user ID for a node (via its nodeRunner)
 */
async function findUserIdForNode(nodeId: string): Promise<string | null> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: { nodeRunnerId: true },
  })
  if (!node?.nodeRunnerId) return null
  return findUserIdForNodeRunner(node.nodeRunnerId)
}

/**
 * Notify that a node went offline
 */
export async function notifyNodeOffline(nodeId: string, nodeName?: string) {
  const userId = await findUserIdForNode(nodeId)
  if (!userId) return null

  const label = nodeName || nodeId.slice(0, 8)
  return createNotification(
    userId,
    'NODE_OFFLINE',
    'Node Offline',
    `Your node ${label} has gone offline. Check the agent status and network connectivity.`,
  )
}

/**
 * Notify that a payout has been sent
 */
export async function notifyPayoutSent(
  nodeRunnerId: string,
  amount: number,
  txHash?: string,
) {
  const userId = await findUserIdForNodeRunner(nodeRunnerId)
  if (!userId) return null

  const txInfo = txHash ? ` TX: ${txHash.slice(0, 12)}...` : ''
  return createNotification(
    userId,
    'PAYOUT_SENT',
    'Payout Sent',
    `A payout of $${amount.toFixed(2)} has been sent to your wallet.${txInfo}`,
  )
}

/**
 * Notify that a job completed on the user's node
 */
export async function notifyJobCompleted(
  nodeId: string,
  jobId: string,
  earnings?: number,
) {
  const userId = await findUserIdForNode(nodeId)
  if (!userId) return null

  const earningsStr = earnings ? ` earning $${earnings.toFixed(4)}` : ''
  return createNotification(
    userId,
    'JOB_COMPLETED',
    'Job Completed',
    `Job ${jobId.slice(0, 8)} completed successfully${earningsStr}.`,
  )
}

/**
 * Notify that a job failed on the user's node
 */
export async function notifyJobFailed(
  nodeId: string,
  jobId: string,
  error?: string,
) {
  const userId = await findUserIdForNode(nodeId)
  if (!userId) return null

  const errorStr = error ? `: ${error.slice(0, 100)}` : ''
  return createNotification(
    userId,
    'JOB_FAILED',
    'Job Failed',
    `Job ${jobId.slice(0, 8)} failed${errorStr}.`,
  )
}

/**
 * Notify that an investment was confirmed (payment received)
 */
export async function notifyInvestmentConfirmed(investmentId: string) {
  const investment = await prisma.investment.findUnique({
    where: { id: investmentId },
    include: { nodeRunner: true },
  })
  if (!investment?.nodeRunner?.userId) return null

  return createNotification(
    investment.nodeRunner.userId,
    'INVESTMENT_CONFIRMED',
    'Payment Confirmed',
    `Your investment of $${investment.amount} for ${investment.gpuTier} has been confirmed. Node provisioning will begin shortly.`,
  )
}

/**
 * Notify that an investment has been provisioned (node is live)
 */
export async function notifyInvestmentProvisioned(investmentId: string) {
  const investment = await prisma.investment.findUnique({
    where: { id: investmentId },
    include: { nodeRunner: true },
  })
  if (!investment?.nodeRunner?.userId) return null

  return createNotification(
    investment.nodeRunner.userId,
    'INVESTMENT_PROVISIONED',
    'Node Provisioned',
    `Your ${investment.gpuTier} node is now live and earning. Check your dashboard for real-time status.`,
  )
}
