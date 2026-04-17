import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { z } from 'zod'
import { generateAccessToken, generateRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens } from '../services/auth/jwt.js'
import { generateNonce, verifyWalletSignature, findOrCreateUserByWallet } from '../services/auth/wallet.js'
import { registerUser, authenticateUser, hashPassword } from '../services/auth/password.js'
import { sendEmail } from '../services/email/sender.js'

// Validation schemas

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['NODE_RUNNER', 'COMPUTE_BUYER']).default('NODE_RUNNER'),
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

const forgotPasswordSchema = z.object({
  email: z.string().email(),
})

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

const verifyEmailSchema = z.object({
  token: z.string().min(1),
})

const PORTAL_URL = process.env.PORTAL_URL || 'https://a2e.byredstone.com/portal'

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

    const { email, password, role } = parsed.data

    try {
      const user = await registerUser(email, password, role)
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

  /**
   * POST /v1/portal/auth/send-verification — Send email verification link
   */
  fastify.post('/v1/portal/auth/send-verification', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: request.user.userId },
    })

    if (!user || !user.email) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'No email address associated with this account',
      })
    }

    if (user.emailVerified) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Email is already verified',
      })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

    await fastify.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: token,
        emailVerificationExpiry: expiry,
      },
    })

    const verifyLink = `${PORTAL_URL}/verify-email?token=${token}`

    void sendEmail(
      user.email,
      'Verify your email — A²E Engine',
      `<h2 style="color: #ffffff; margin: 0 0 16px;">Verify Your Email</h2>
       <p style="color: #a1a1aa; line-height: 1.6;">
         Click the button below to verify your email address.
       </p>
       <div style="text-align: center; margin: 32px 0;">
         <a href="${verifyLink}" style="display: inline-block; background: #22c55e; color: #000000; font-weight: 600; padding: 12px 32px; border-radius: 8px; text-decoration: none;">
           Verify Email
         </a>
       </div>
       <p style="color: #71717a; font-size: 13px;">
         This link expires in 24 hours. If you didn't request this, you can safely ignore this email.
       </p>`,
    )

    reply.send({ success: true, message: 'Verification email sent' })
  })

  /**
   * POST /v1/portal/auth/verify-email — Verify email with token
   */
  fastify.post('/v1/portal/auth/verify-email', async (request, reply) => {
    const parsed = verifyEmailSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'Token is required',
      })
    }

    const user = await fastify.prisma.user.findFirst({
      where: { emailVerificationToken: parsed.data.token },
    })

    if (!user) {
      return reply.code(400).send({
        error: 'Invalid Token',
        message: 'Verification token is invalid or has already been used',
      })
    }

    if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
      return reply.code(400).send({
        error: 'Token Expired',
        message: 'Verification token has expired. Please request a new one.',
      })
    }

    await fastify.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpiry: null,
      },
    })

    reply.send({ success: true, message: 'Email verified successfully' })
  })

  /**
   * POST /v1/portal/auth/forgot-password — Request password reset email
   */
  fastify.post('/v1/portal/auth/forgot-password', async (request, reply) => {
    const parsed = forgotPasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'A valid email address is required',
      })
    }

    const user = await fastify.prisma.user.findUnique({
      where: { email: parsed.data.email },
    })

    // Always return success to prevent email enumeration
    if (!user) {
      reply.send({ success: true, message: 'If an account exists with that email, a reset link has been sent' })
      return
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    await fastify.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: token,
        passwordResetExpiry: expiry,
      },
    })

    const resetLink = `${PORTAL_URL}/reset-password?token=${token}`

    void sendEmail(
      parsed.data.email,
      'Reset your password — A²E Engine',
      `<h2 style="color: #ffffff; margin: 0 0 16px;">Reset Your Password</h2>
       <p style="color: #a1a1aa; line-height: 1.6;">
         We received a request to reset your password. Click the button below to choose a new one.
       </p>
       <div style="text-align: center; margin: 32px 0;">
         <a href="${resetLink}" style="display: inline-block; background: #22c55e; color: #000000; font-weight: 600; padding: 12px 32px; border-radius: 8px; text-decoration: none;">
           Reset Password
         </a>
       </div>
       <p style="color: #71717a; font-size: 13px;">
         This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
       </p>`,
    )

    reply.send({ success: true, message: 'If an account exists with that email, a reset link has been sent' })
  })

  /**
   * POST /v1/portal/auth/reset-password — Reset password with token
   */
  fastify.post('/v1/portal/auth/reset-password', async (request, reply) => {
    const parsed = resetPasswordSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map(e => e.message).join(', '),
      })
    }

    const user = await fastify.prisma.user.findFirst({
      where: { passwordResetToken: parsed.data.token },
    })

    if (!user) {
      return reply.code(400).send({
        error: 'Invalid Token',
        message: 'Reset token is invalid or has already been used',
      })
    }

    if (user.passwordResetExpiry && user.passwordResetExpiry < new Date()) {
      return reply.code(400).send({
        error: 'Token Expired',
        message: 'Reset token has expired. Please request a new one.',
      })
    }

    const newHash = await hashPassword(parsed.data.password)

    await fastify.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        passwordResetToken: null,
        passwordResetExpiry: null,
      },
    })

    // Revoke all existing refresh tokens for security
    await revokeAllUserTokens(user.id)

    reply.send({ success: true, message: 'Password reset successfully' })
  })
}
