import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { generateAccessToken, generateRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens } from '../services/auth/jwt.js'
import { generateNonce, verifyWalletSignature, findOrCreateUserByWallet } from '../services/auth/wallet.js'
import { registerUser, authenticateUser } from '../services/auth/password.js'

// Validation schemas

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(100).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const walletNonceSchema = z.object({
  address: z.string().min(32).max(64),
})

const walletAuthSchema = z.object({
  address: z.string().min(32).max(64),
  signature: z.string().min(1),
  nonce: z.string().min(1),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export async function portalAuthRoutes(fastify: FastifyInstance) {

  /**
   * POST /v1/portal/auth/register — Email/password registration
   */
  fastify.post('/v1/portal/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map(e => e.message).join(', '),
      })
    }

    const { email, password } = parsed.data

    try {
      const user = await registerUser(email, password, 'NODE_RUNNER')
      const accessToken = generateAccessToken(user.id, user.role)
      const refreshToken = await generateRefreshToken(user.id)

      reply.code(201).send({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
        accessToken,
        refreshToken,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'Email already registered') {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Email already registered',
        })
      }
      throw error
    }
  })

  /**
   * POST /v1/portal/auth/login — Email/password login
   */
  fastify.post('/v1/portal/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'Email and password are required',
      })
    }

    const { email, password } = parsed.data
    const user = await authenticateUser(email, password)

    if (!user) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      })
    }

    const accessToken = generateAccessToken(user.id, user.role)
    const refreshToken = await generateRefreshToken(user.id)

    reply.send({
      user: {
        id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        role: user.role,
        nodeRunnerId: user.nodeRunner?.id ?? null,
      },
      accessToken,
      refreshToken,
    })
  })

  /**
   * GET /v1/portal/auth/wallet/nonce — Get nonce for wallet to sign
   */
  fastify.get('/v1/portal/auth/wallet/nonce', async (request, reply) => {
    const parsed = walletNonceSchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'Wallet address is required',
      })
    }

    const { address } = parsed.data
    const nonce = generateNonce(address)

    reply.send({
      nonce,
      message: `Sign this message to authenticate with A²E Engine.\n\nNonce: ${nonce}`,
    })
  })

  /**
   * POST /v1/portal/auth/wallet — Wallet signature authentication
   */
  fastify.post('/v1/portal/auth/wallet', async (request, reply) => {
    const parsed = walletAuthSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map(e => e.message).join(', '),
      })
    }

    const { address, signature, nonce } = parsed.data

    // Verify the signature
    const valid = verifyWalletSignature(address, signature, nonce)
    if (!valid) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid wallet signature',
      })
    }

    // Find or create user
    const user = await findOrCreateUserByWallet(address)
    const accessToken = generateAccessToken(user.id, user.role)
    const refreshToken = await generateRefreshToken(user.id)

    reply.send({
      user: {
        id: user.id,
        email: user.email,
        walletAddress: user.walletAddress,
        role: user.role,
        nodeRunnerId: user.nodeRunner?.id ?? null,
      },
      accessToken,
      refreshToken,
    })
  })

  /**
   * POST /v1/portal/auth/refresh — Rotate refresh token
   */
  fastify.post('/v1/portal/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'Refresh token is required',
      })
    }

    const result = await rotateRefreshToken(parsed.data.refreshToken)

    if (!result) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
      })
    }

    reply.send({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })
  })

  /**
   * POST /v1/portal/auth/logout — Revoke refresh token
   */
  fastify.post('/v1/portal/auth/logout', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body)
    if (parsed.success) {
      await revokeRefreshToken(parsed.data.refreshToken)
    }

    reply.send({ success: true })
  })

  /**
   * GET /v1/portal/auth/me — Get current user profile (requires Bearer token)
   */
  fastify.get('/v1/portal/auth/me', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: request.user.userId },
      include: { nodeRunner: true },
    })

    if (!user) {
      return reply.code(404).send({ error: 'User not found' })
    }

    reply.send({
      id: user.id,
      email: user.email,
      walletAddress: user.walletAddress,
      role: user.role,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      nodeRunnerId: user.nodeRunner?.id ?? null,
      nodeRunnerName: user.nodeRunner?.name ?? null,
      createdAt: user.createdAt,
    })
  })

  /**
   * POST /v1/portal/auth/logout-all — Revoke all refresh tokens (logout everywhere)
   */
  fastify.post('/v1/portal/auth/logout-all', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    await revokeAllUserTokens(request.user.userId)
    reply.send({ success: true })
  })
}
