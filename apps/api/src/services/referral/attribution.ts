/**
 * M5.7 / D2: referral attribution.
 *
 * Called once when a brand-new operator's NodeRunner row is created.
 * If the signup carried a ?ref=<CODE> query param, this writes the
 * Referral row pointing the new operator at the referrer and starts the
 * 365-day commission window. A NodeRunner can only ever appear as a
 * referee on one Referral row (enforced by the @unique constraint on
 * refereeNodeRunnerId).
 */

import type { PrismaClient } from '@a2e/database'

const REFERRAL_WINDOW_DAYS = parseInt(process.env.REFERRAL_WINDOW_DAYS ?? '365', 10)

export interface AttributionResult {
  status: 'ATTRIBUTED' | 'NO_CODE' | 'INVALID_CODE' | 'SELF_REFERRAL' | 'ALREADY_REFERRED'
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
    select: { id: true },
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

  const expiresAt = new Date(Date.now() + REFERRAL_WINDOW_DAYS * 86400000)
  const row = await prisma.referral.create({
    data: {
      code,
      referrerNodeRunnerId: referrer.id,
      refereeNodeRunnerId,
      expiresAt,
      status: 'ACTIVE',
    },
    select: { id: true },
  })

  return { status: 'ATTRIBUTED', referralId: row.id }
}
