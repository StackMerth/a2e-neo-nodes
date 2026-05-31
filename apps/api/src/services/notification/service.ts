import { prisma } from '@a2e/database'
import type { NotificationType } from '@a2e/database'
import type { Server as SocketServer } from 'socket.io'
import { sendEmail, isEmailConfigured } from '../email/sender.js'
import { sendPushToUser, isPushConfigured } from './push.js'
import {
  renderBalanceTopupReceipt,
  renderGenericBody,
  type BalanceTopupReceiptArgs,
} from '../email/templates.js'

/**
 * T8b: optional structured data the email renderer uses for richer
 * per-type templates. The notification row itself still stores the
 * generic title + message + link (the in-app bell never sees this
 * extra data); only the email body uses the structured fields.
 */
export type NotificationTemplateData =
  | { kind: 'BALANCE_TOPUP'; amountUsd: number; source: string; newBalanceUsd: number; occurredAt?: string; referenceId?: string }
  | { kind: 'generic' }

const PORTAL_URL = process.env.PORTAL_URL ?? 'https://user.tokenos.ai'

/** WebSocket server reference — set during server startup */
let io: SocketServer | null = null

/** Set the Socket.io server reference for real-time notification push */
export function setNotificationSocket(server: SocketServer) {
  io = server
}

/** Notification types that should also trigger an email */
const EMAIL_NOTIFICATION_TYPES: NotificationType[] = [
  'NODE_OFFLINE',
  'PAYOUT_SENT',
  'DEPLOYMENT_COMPLETED',
  'COMPUTE_ACTIVE',
  'WITHDRAWAL_COMPLETED',
  // C5: first-event activation emails — make first heartbeat + first
  // earning feel like a moment. Both are one-shot per operator.
  'FIRST_HEARTBEAT_RECEIVED',
  'FIRST_EARNING',
  // C4: benchmark anomaly — operator should hear about a sudden score
  // drop even if they're not watching the dashboard.
  'NODE_DEGRADED',
  // T2.1: balance top-up landed. Same logic as PAYOUT_SENT — money
  // movement events ship a receipt-style email so the user gets
  // confirmation even when offline.
  'BALANCE_TOPUP',
]

/**
 * Create a notification for a user and emit via WebSocket.
 * For certain high-priority types, also sends an email if SMTP is configured.
 */
export async function createNotification(
  userId: string,
  type: NotificationType,
  title: string,
  message: string,
  link?: string,
  templateData?: NotificationTemplateData,
) {
  const notification = await prisma.notification.create({
    data: { userId, type, title, message, link: link ?? null },
  })

  // Push real-time notification via WebSocket
  io?.emit('notification:new', {
    userId,
    id: notification.id,
    type,
    title,
    message,
    link: link ?? null,
  })

  // Send web push to every subscribed device (non-blocking). Push
  // is throttle-less + free for the user, so unlike email we fire
  // on every notification type rather than only the high-priority
  // list. Service worker handles tag-based stacking client-side so
  // a burst of compute:tick events does not pile up in the tray.
  if (isPushConfigured()) {
    void (async () => {
      try {
        await sendPushToUser(userId, {
          title,
          body: message,
          url: link ? `${PORTAL_URL}${link}` : PORTAL_URL,
          tag: type,
        })
      } catch {
        // Push delivery failures must never bubble up — the
        // notification row + websocket emit have already happened.
      }
    })()
  }

  // Send email for high-priority notification types (non-blocking)
  if (EMAIL_NOTIFICATION_TYPES.includes(type)) {
    void (async () => {
      try {
        const configured = await isEmailConfigured()
        if (!configured) return

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        })
        if (!user?.email) return

        // T8b: route to the type-specific HTML template when the
        // caller provided structured data. Falls back to the generic
        // title + message block when no template data is passed,
        // preserving every pre-T8b call site's email shape.
        const html = renderEmailBody(type, title, message, link, templateData)
        void sendEmail(
          user.email,
          `${title} — TokenOS_DeAI`,
          html,
        )
      } catch {
        // Email delivery should never block notification creation
      }
    })()
  }

  return notification
}

/**
 * T8b: pick the right HTML body renderer for a given notification
 * type + templateData. Type-specific paths (BALANCE_TOPUP receipt
 * etc.) only fire when the caller passed matching templateData;
 * otherwise the generic title+message block is used so legacy call
 * sites (no third arg) get the exact same email they always did.
 */
function renderEmailBody(
  type: NotificationType,
  title: string,
  message: string,
  link: string | undefined,
  templateData: NotificationTemplateData | undefined,
): string {
  if (type === 'BALANCE_TOPUP' && templateData?.kind === 'BALANCE_TOPUP') {
    const args: BalanceTopupReceiptArgs = {
      title,
      message,
      link,
      amountUsd: templateData.amountUsd,
      source: templateData.source,
      newBalanceUsd: templateData.newBalanceUsd,
      occurredAt: templateData.occurredAt,
      referenceId: templateData.referenceId,
    }
    return renderBalanceTopupReceipt(args)
  }
  return renderGenericBody({ title, message, link })
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
 * Notify that a node went offline. Deep-links to the operator's
 * node detail page so they can jump straight to the diagnostic view.
 */
export async function notifyNodeOffline(nodeId: string, nodeName?: string) {
  const userId = await findUserIdForNode(nodeId)
  if (!userId) return null

  const label = nodeName || nodeId.slice(0, 8)
  return createNotification(
    userId,
    'NODE_OFFLINE',
    'Node Offline',
    `Your node ${label} has gone offline. Tap to view node status.`,
    `/nodes/${nodeId}`,
  )
}

/**
 * Notify that a payout has been sent. Deep-links to the operator's
 * settlement history.
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
    '/payouts',
  )
}

/**
 * Notify that a job completed on the user's node. Deep-links to the
 * job detail page so the operator can see the run output.
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
    `Job ${jobId.slice(0, 8)} completed successfully${earningsStr}. Tap to view.`,
    `/jobs/${jobId}`,
  )
}

/**
 * Notify that a job failed on the user's node. Deep-links to the
 * job detail page where the failure logs live.
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
    `Job ${jobId.slice(0, 8)} failed${errorStr}. Tap to view logs.`,
    `/jobs/${jobId}`,
  )
}

/**
 * Notify that an investment was confirmed (payment received). Deep-
 * links to the investments page so the operator can track the
 * provisioning status.
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
    '/investments',
  )
}

/**
 * Notify that an investment has been provisioned (node is live).
 * Deep-links to the nodes list where the new node will show up.
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
    `Your ${investment.gpuTier} node is now live and earning. Tap to view.`,
    '/nodes',
  )
}

/**
 * C5: Notify operator their first-ever heartbeat just landed. Fired
 * once per NodeRunner from the heartbeat handler when firstHeartbeatAt
 * is null. Activation email + bell entry. Caller must resolve the
 * nodeRunner's userId; we don't re-query here to keep the heartbeat
 * hot path tight.
 */
export async function notifyFirstHeartbeat(userId: string, nodeLabel: string) {
  return createNotification(
    userId,
    'FIRST_HEARTBEAT_RECEIVED',
    'Your first node is live',
    `Heartbeat received from ${nodeLabel}. You're set up. Earnings start accruing as soon as a buyer rents your GPU.`,
    '/dashboard',
  )
}

/**
 * C5: Notify operator their first-ever non-zero earning just landed.
 * Fired once per NodeRunner from the earnings-rollup worker when
 * firstEarningAt is null. Activation email + bell entry.
 */
export async function notifyFirstEarning(userId: string, amount: number) {
  return createNotification(
    userId,
    'FIRST_EARNING',
    'You earned your first reward',
    `Your first earning of $${amount.toFixed(2)} just landed. Track real-time totals on your dashboard.`,
    '/earnings',
  )
}

/**
 * C4: Notify operator that a node's benchmark score dropped sharply
 * (>20% relative to the previous score). Fired from the benchmark
 * result callback on the API side. Links to the node detail page so
 * the operator can re-run or investigate.
 */
export async function notifyNodeDegraded(
  userId: string,
  nodeLabel: string,
  nodeId: string,
  oldScore: number,
  newScore: number,
) {
  const dropPct = oldScore > 0 ? Math.round(((oldScore - newScore) / oldScore) * 100) : 0
  return createNotification(
    userId,
    'NODE_DEGRADED',
    'Node performance dropped',
    `${nodeLabel} benchmark fell ${dropPct}% (${oldScore.toFixed(0)} → ${newScore.toFixed(0)}). Check thermal / driver / power throttling.`,
    `/nodes/${nodeId}`,
  )
}
