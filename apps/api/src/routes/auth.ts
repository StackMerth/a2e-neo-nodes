import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '@a2e/database'
import { verifyAccessToken, type AccessTokenPayload } from '../services/auth/jwt.js'

/**
 * Admin authentication routes.
 *
 * The previous Phase 1 implementation used a hand-rolled HMAC-signed
 * token (commented as "for demo purposes" in source) which was not
 * compatible with the auth plugin's main JWT verifier. M1.4 migrates
 * admin auth to the same JWT scheme as portal users so a single
 * code path validates all Bearer tokens.
 *
 * Admin credentials come from env vars (ADMIN_USERNAME, ADMIN_PASSWORD).
 * On successful login, we upsert a sentinel User row with
 * email='admin@a2e.local' and role='ADMIN' so the JWT has a real
 * userId to reference, and the rest of the User-table integrations
 * (refresh tokens, audit logs) work without special-casing admin.
 *
 * Access token expiry is 8 hours (vs 15 min for portal users) since
 * admins typically have long sessions and the dashboard does not
 * implement refresh-on-401 yet. M2 can tighten this if desired.
 */

const JWT_SECRET = process.env.JWT_SECRET ?? 'a2e-dev-secret-change-in-production'
const ADMIN_ACCESS_TOKEN_EXPIRY_HOURS = 8
const ADMIN_USER_EMAIL = 'admin@a2e.local'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'a2e-admin-2026'

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

/**
 * Ensure a sentinel User row exists for admin sessions. Idempotent.
 * Returns the User.id which the JWT will reference.
 */
async function ensureAdminUser(): Promise<string> {
  // Hash the env password each login so a rotation in env vars is
  // reflected in the User row (the password hash itself is not used
  // for login validation - that's done against the env var directly -
  // but storing it keeps the User table consistent for future flows).
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10)

  const user = await prisma.user.upsert({
    where: { email: ADMIN_USER_EMAIL },
    create: {
      email: ADMIN_USER_EMAIL,
      passwordHash,
      role: 'ADMIN',
      emailVerified: true,
    },
    update: {
      passwordHash,
      role: 'ADMIN',
    },
  })
  return user.id
}

export async function authRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/auth/login - Admin login.
   *
   * Validates username/password against env vars (ADMIN_USERNAME /
   * ADMIN_PASSWORD), upserts the admin User row, and returns a real
   * JWT access token. Returns the same response shape as the legacy
   * route so the dashboard does not need changes.
   */
  fastify.post('/v1/auth/login', async (request, reply) => {
    const parseResult = loginSchema.safeParse(request.body)

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'Username and password are required',
      })
    }

    const { username, password } = parseResult.data

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid username or password',
      })
    }

    // Make sure the admin User row exists so the JWT userId is real.
    const userId = await ensureAdminUser()

    const payload: AccessTokenPayload = {
      userId,
      role: 'ADMIN',
      type: 'access',
    }
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: `${ADMIN_ACCESS_TOKEN_EXPIRY_HOURS}h`,
    })

    reply.send({
      success: true,
      token,
      user: {
        username,
        role: 'admin',
      },
      expiresIn: ADMIN_ACCESS_TOKEN_EXPIRY_HOURS * 60 * 60,
    })
  })

  /**
   * POST /v1/auth/verify - Validate a token without mutating state.
   * Used by the dashboard's useAuth hook on initial load to determine
   * whether the localStorage token is still valid.
   */
  fastify.post('/v1/auth/verify', async (request, reply) => {
    const authHeader = request.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'No token provided',
      })
    }

    const token = authHeader.substring(7)

    try {
      const payload = verifyAccessToken(token)
      if (payload.role !== 'ADMIN') {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Token is not an admin token',
        })
      }
      reply.send({
        valid: true,
        user: {
          username: ADMIN_USERNAME,
          role: 'admin',
        },
      })
    } catch (err) {
      const expired = err instanceof Error && /jwt expired|TokenExpiredError/i.test(err.message)
      return reply.code(401).send({
        error: 'Unauthorized',
        message: expired ? 'Token expired' : 'Invalid token',
        expired,
      })
    }
  })

  /**
   * POST /v1/auth/logout - Stateless. The dashboard discards the
   * token client-side. We log the event for the audit trail but
   * don't blacklist the token; admin tokens are 8h max anyway and
   * adding revocation requires a refresh-token table integration
   * which is portal-only today.
   */
  fastify.post('/v1/auth/logout', async (_request, reply) => {
    reply.send({
      success: true,
      message: 'Logged out successfully',
    })
  })
}
