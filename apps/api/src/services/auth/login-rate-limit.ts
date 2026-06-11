/**
 * Login rate limiter (Redis-backed).
 *
 * SECURITY (pen-test A2 2026-06-10):
 * POST /v1/portal/auth/login accepted unlimited rapid wrong-password
 * attempts (audit confirmed 8 back-to-back wrongs, all 401, no 429 /
 * lockout / backoff). This service rate-limits by BOTH source IP AND
 * target email so brute-force attempts can be slowed AND credential-
 * stuffing across rotating accounts is still bounded by per-IP cost.
 *
 * Sliding window via Redis INCR + EXPIRE:
 *   - Failed login: increment both counters, set TTL.
 *   - Counter at or above limit: subsequent attempts return 429 until TTL.
 *   - Successful login: reset both counters so a legitimate user who
 *     made a few typos isn't locked out after they finally got it right.
 *
 * Counters are keyed by lower-cased email to defeat case-shuffling
 * attempts (Login@example.com vs login@example.com). IP normalization
 * leaves IPv6 alone because Render's proxy already canonicalizes.
 *
 * Per-IP limit is HIGHER than per-email limit because shared NAT (a
 * coffee shop, a corp VPN) legitimately sees many users. Per-email
 * is lower because brute-force always targets a specific account.
 *
 * Env config:
 *   LOGIN_RATE_LIMIT_MAX_PER_IP        default 30
 *   LOGIN_RATE_LIMIT_MAX_PER_EMAIL     default 5
 *   LOGIN_RATE_LIMIT_WINDOW_SECONDS    default 900 (15 min)
 *
 * Fail-open: if Redis is unreachable, the limiter logs and ALLOWS the
 * request rather than blocking all auth. We'd rather fail to limit
 * than fail to authenticate during a Redis outage.
 */

import type { Redis } from 'ioredis'

const MAX_PER_IP = parseInt(process.env.LOGIN_RATE_LIMIT_MAX_PER_IP ?? '30', 10)
const MAX_PER_EMAIL = parseInt(
  process.env.LOGIN_RATE_LIMIT_MAX_PER_EMAIL ?? '5',
  10,
)
const WINDOW_SECONDS = parseInt(
  process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS ?? '900',
  10,
)

function ipKey(ip: string): string {
  return `login-attempts:ip:${ip}`
}

function emailKey(email: string): string {
  return `login-attempts:email:${email.toLowerCase()}`
}

export interface LoginRateLimitState {
  blocked: boolean
  // Resource that exceeded its limit ('ip' or 'email'). For ops only.
  reason?: 'ip' | 'email'
  // Seconds until the limit window resets. UI can surface this in a
  // 'try again in ~Xm' message.
  retryAfterSeconds?: number
}

/**
 * Check whether the next login attempt from (ip, email) should be
 * allowed. Returns blocked=true if either counter is at or above its
 * limit. The check itself does not mutate state — only failed/succeeded
 * recorders below do.
 */
export async function checkLoginRateLimit(
  redis: Redis,
  ip: string,
  email: string,
): Promise<LoginRateLimitState> {
  try {
    const [ipCountStr, emailCountStr, ipTtl, emailTtl] = await Promise.all([
      redis.get(ipKey(ip)),
      redis.get(emailKey(email)),
      redis.ttl(ipKey(ip)),
      redis.ttl(emailKey(email)),
    ])
    const ipCount = ipCountStr ? parseInt(ipCountStr, 10) : 0
    const emailCount = emailCountStr ? parseInt(emailCountStr, 10) : 0
    if (emailCount >= MAX_PER_EMAIL) {
      return {
        blocked: true,
        reason: 'email',
        retryAfterSeconds: emailTtl > 0 ? emailTtl : WINDOW_SECONDS,
      }
    }
    if (ipCount >= MAX_PER_IP) {
      return {
        blocked: true,
        reason: 'ip',
        retryAfterSeconds: ipTtl > 0 ? ipTtl : WINDOW_SECONDS,
      }
    }
    return { blocked: false }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-rate-limit] Redis check failed; allowing:', err)
    return { blocked: false }
  }
}

/**
 * Record a failed login so subsequent attempts may be blocked. Sets
 * TTL on first increment so the window slides correctly.
 */
export async function recordFailedLogin(
  redis: Redis,
  ip: string,
  email: string,
): Promise<void> {
  try {
    const ipK = ipKey(ip)
    const emailK = emailKey(email)
    const [ipCount, emailCount] = await Promise.all([
      redis.incr(ipK),
      redis.incr(emailK),
    ])
    // EXPIRE on FIRST increment so the window starts at the first
    // failure and we don't reset it on every subsequent failure (which
    // would make the lockout effectively permanent under rapid attacks).
    const toSet: Promise<unknown>[] = []
    if (ipCount === 1) toSet.push(redis.expire(ipK, WINDOW_SECONDS))
    if (emailCount === 1) toSet.push(redis.expire(emailK, WINDOW_SECONDS))
    if (toSet.length) await Promise.all(toSet)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-rate-limit] Redis record failed:', err)
  }
}

/**
 * Reset both counters on a successful login so a user who finally got
 * their password right after 3 typos doesn't sit in lockout for the
 * remainder of the window.
 */
export async function resetLoginAttempts(
  redis: Redis,
  ip: string,
  email: string,
): Promise<void> {
  try {
    await Promise.all([
      redis.del(ipKey(ip)),
      redis.del(emailKey(email)),
    ])
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-rate-limit] Redis reset failed:', err)
  }
}
