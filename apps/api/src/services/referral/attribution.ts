/**
 * M5.7 / D2: referral attribution.
 *
 * Called once when a brand-new operator's NodeRunner row is created.
 * If the signup carried a ?ref=<CODE> query param, this writes the
 * Referral row pointing the new operator at the referrer and starts the
 * 365-day commission window. A NodeRunner can only ever appear as a
 * referee on one Referral row (enforced by the @unique constraint on
 * refereeNodeRunnerId).
 *
 * Anti-abuse (M5.7 polish):
 *   - IP sock-puppet check: if the referee's signupIp matches the
 *     referrer's signupIp, the Referral row is still created (for
 *     audit) but immediately set to REVOKED with a log warn. The
 *     commission worker skips REVOKED rows, so no payout flows. Admin
 *     can manually un-revoke via SQL if the match is legitimate (same
 *     household, shared office, etc).
 *   - Set REFERRAL_IP_CHECK_ENABLED=0 to disable the check in dev.
 */

import type { PrismaClient } from '@a2e/database'

const REFERRAL_WINDOW_DAYS = parseInt(process.env.REFERRAL_WINDOW_DAYS ?? '365', 10)
const IP_CHECK_ENABLED = process.env.REFERRAL_IP_CHECK_ENABLED !== '0'

export interface AttributionResult {
  status: 'ATTRIBUTED' | 'NO_CODE' | 'INVALID_CODE' | 'SELF_REFERRAL' | 'ALREADY_REFERRED' | 'SOCK_PUPPET_FLAGGED'
  referralId?: string
}

export async function attributeReferral(
  prisma: PrismaClient,
  refereeNodeRunnerId: string,
  code: string | null | undefined,
): Promise<AttributionResult> {
  if (!code) return { status: 'NO_CODE' }

  const referrer = await prisma.nodeRunner.findUnique({
    where: { referralCode: code },
    select: { id: true, userId: true },
  })
  if (!referrer) return { status: 'INVALID_CODE' }
  if (referrer.id === refereeNodeRunnerId) return { status: 'SELF_REFERRAL' }

  // The unique constraint on refereeNodeRunnerId prevents an operator
  // from being re-attributed to a different referrer later. We surface
  // that as ALREADY_REFERRED rather than letting the Prisma error
  // bubble.
  const existing = await prisma.referral.findUnique({
    where: { refereeNodeRunnerId },
    select: { id: true },
  })
  if (existing) return { status: 'ALREADY_REFERRED', referralId: existing.id }

  // Anti-abuse IP check. Both referrer + referee must be linked to
  // User rows with non-null signupIp values for the comparison to
  // fire; if either is null we skip the check (e.g. operators created
  // by seed scripts have no signup IP).
  let sockPuppetFlagged = false
  if (IP_CHECK_ENABLED && referrer.userId) {
    const refereeRunner = await prisma.nodeRunner.findUnique({
      where: { id: refereeNodeRunnerId },
      select: { userId: true },
    })
    if (refereeRunner?.userId) {
      const [referrerUser, refereeUser] = await Promise.all([
        prisma.user.findUnique({ where: { id: referrer.userId }, select: { signupIp: true } }),
        prisma.user.findUnique({ where: { id: refereeRunner.userId }, select: { signupIp: true } }),
      ])
      if (
        referrerUser?.signupIp &&
        refereeUser?.signupIp &&
        referrerUser.signupIp === refereeUser.signupIp
      ) {
        sockPuppetFlagged = true
      }
    }
  }

  const expiresAt = new Date(Date.now() + REFERRAL_WINDOW_DAYS * 86400000)
  const row = await prisma.referral.create({
    data: {
      code,
      referrerNodeRunnerId: referrer.id,
      refereeNodeRunnerId,
      expiresAt,
      // Sock-puppet pairs land as REVOKED so the commission worker
      // skips them, but the row stays for audit + manual override.
      status: sockPuppetFlagged ? 'REVOKED' : 'ACTIVE',
    },
    select: { id: true },
  })

  if (sockPuppetFlagged) {
    // eslint-disable-next-line no-console
    console.warn(
      `[referral-attribution] SOCK_PUPPET_FLAGGED referral=${row.id} referrer=${referrer.id} referee=${refereeNodeRunnerId} (shared signup IP)`,
    )
    return { status: 'SOCK_PUPPET_FLAGGED', referralId: row.id }
  }

  return { status: 'ATTRIBUTED', referralId: row.id }
}
