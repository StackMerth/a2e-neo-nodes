/**
 * NodeRunner slug helper.
 *
 * The vanity profile lives at /operator/<slug> and the leaderboard
 * filters operators with null slugs out (since the row links there).
 * NodeRunner rows auto-created by the referral, deploy, and test-flow
 * paths don't get a slug at creation time, which silently hides them
 * from the leaderboard.
 *
 * `ensureSlug` makes the slug column populated for every NodeRunner
 * that goes through the referral system. Called from
 * `ensureReferralCode`, so every operator who fetches their invite
 * code (which is everyone who lands on /referral) gets a slug as a
 * side effect.
 *
 * Slug shape: <name-kebab>-<id-suffix> where the suffix is the first
 * 6 chars of the cuid. Keeps it short, human-readable, and unique
 * across operators with the same name.
 */
import type { PrismaClient } from '@a2e/database'

export async function ensureSlug(prisma: PrismaClient, nodeRunnerId: string): Promise<string> {
  const existing = await prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: { slug: true, name: true },
  })
  if (!existing) throw new Error(`NodeRunner ${nodeRunnerId} not found`)
  if (existing.slug) return existing.slug

  const base = slugifyName(existing.name)
  const suffix = nodeRunnerId.slice(-6)

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? `${base}-${suffix}` : `${base}-${suffix}-${attempt}`
    try {
      const updated = await prisma.nodeRunner.update({
        where: { id: nodeRunnerId },
        data: { slug: candidate },
        select: { slug: true },
      })
      return updated.slug!
    } catch (err) {
      const e = err as { code?: string }
      if (e?.code !== 'P2002') throw err
      // unique conflict, try next suffix
    }
  }
  throw new Error(`Failed to allocate a unique slug for NodeRunner ${nodeRunnerId} after 5 attempts`)
}

function slugifyName(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'operator'
}
