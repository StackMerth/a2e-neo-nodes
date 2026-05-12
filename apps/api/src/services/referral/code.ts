/**
 * M5.7 / D2: referral code generator.
 *
 * 8-character base32 codes using an alphabet that excludes ambiguous
 * glyphs (0/O/I/1/L). Generated with crypto.randomInt to keep entropy
 * predictable. Caller is responsible for uniqueness verification, but
 * the alphabet + length give 32^8 = ~1.1 trillion possible codes, so a
 * collision in the realistic operator-network range (<100k accounts) is
 * astronomically unlikely. The DB-level @unique on referralCode catches
 * any conflict at write time.
 */

import { randomInt } from 'node:crypto'
import type { PrismaClient } from '@a2e/database'
import { ensureSlug } from './slug.js'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

export function generateReferralCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)]
  }
  return out
}

/**
 * Ensure a NodeRunner has a referralCode. If absent, generate one and
 * write it. Returns the final code. Retries on the rare DB collision.
 */
export async function ensureReferralCode(
  prisma: PrismaClient,
  nodeRunnerId: string,
): Promise<string> {
  // Always make sure the runner has a slug too. The leaderboard
  // filters out slug-less rows because each row links to /operator/<slug>;
  // without this, every newly auto-created NodeRunner stays invisible on
  // the public leaderboard until manually slugged.
  await ensureSlug(prisma, nodeRunnerId)

  const existing = await prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: { referralCode: true },
  })
  if (existing?.referralCode) return existing.referralCode

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode()
    try {
      const updated = await prisma.nodeRunner.update({
        where: { id: nodeRunnerId },
        data: { referralCode: code },
        select: { referralCode: true },
      })
      return updated.referralCode!
    } catch (err) {
      // Unique-constraint conflict, try a new code. Anything else, bubble.
      if (!isUniqueConstraintError(err)) throw err
    }
  }
  throw new Error(`Failed to allocate a unique referral code for runner ${nodeRunnerId} after 5 attempts`)
}

function isUniqueConstraintError(err: unknown): boolean {
  const e = err as { code?: string }
  return e?.code === 'P2002'
}
