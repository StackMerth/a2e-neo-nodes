/**
 * M2 / B1: ephemeral SSH session credentials.
 *
 * Replaces the persistent sshPassword stored on ComputeRequest with a
 * short-lived session token that is rotated when the rental ends or the
 * token expires. The token is what the buyer presents at login; the
 * node-agent maps it to the actual short-term unix account it created
 * for that rental.
 *
 * Why this matters: previously a buyer who scraped their password kept
 * SSH access forever. With ephemeral tokens, even a leaked credential is
 * useless after the rental ends because the node-agent revokes the
 * underlying account.
 *
 * Scope of this file: token generation + lifetime calculation only. The
 * agent-side rotation logic lives in apps/node-agent (touched in M2.6).
 */

import { randomBytes } from 'node:crypto'

// Token length in bytes before base64url encoding. 32 bytes = 256 bits of
// entropy, plenty for a short-lived credential. Encoded length is 43 chars.
const TOKEN_BYTES = 32

// Default session lifetime mirrors the rental duration cap. We don't want
// a token that outlives the rental itself, so this is computed per-call
// from the rental's durationDays. The cap below is a safety net for
// defensive coding only; a buyer can't actually set durationDays beyond
// the route validator.
const MAX_SESSION_DAYS = 90

export interface SshSessionCredential {
  token: string
  expiresAt: Date
}

/**
 * Mint a fresh SSH session credential bound to the rental's lifetime.
 *
 * Caller passes durationDays (the buyer's rental window). The returned
 * token expires at min(now + durationDays, now + MAX_SESSION_DAYS) plus
 * a 1-hour grace window so the buyer doesn't get locked out by clock skew
 * or last-second commands.
 */
export function mintSshSession(durationDays: number): SshSessionCredential {
  const days = Math.min(durationDays, MAX_SESSION_DAYS)
  const ms = days * 24 * 60 * 60 * 1000 + 60 * 60 * 1000 // grace hour

  return {
    token: randomBytes(TOKEN_BYTES).toString('base64url'),
    expiresAt: new Date(Date.now() + ms),
  }
}

/**
 * Convenience for rotating a token mid-session (e.g. on agent restart or
 * if the buyer suspects compromise). Same as mintSshSession but reads
 * intent: the caller is replacing an existing credential.
 */
export function rotateSshSession(durationDaysRemaining: number): SshSessionCredential {
  return mintSshSession(durationDaysRemaining)
}
