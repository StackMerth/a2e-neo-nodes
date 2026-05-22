import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { z } from 'zod'
import { generateAccessToken, generateRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens } from '../services/auth/jwt.js'
import { generateNonce, verifyWalletSignature, findOrCreateUserByWallet } from '../services/auth/wallet.js'
import { registerUser, authenticateUser, hashPassword } from '../services/auth/password.js'
import { sendEmail } from '../services/email/sender.js'
import { attributeReferral } from '../services/referral/attribution.js'
import { createNotification } from '../services/notification/service.js'

// Validation schemas

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(100).optional(),
  role: z.enum(['NODE_RUNNER', 'COMPUTE_BUYER']).default('NODE_RUNNER'),
  // M5.7 polish: ?ref=<CODE> propagated from the marketplace share URL
  // through to signup. We only enforce shape here; attribution validates
  // existence + applies the rule that referee role must be NODE_RUNNER.
  referralCode: z.string().min(4).max(16).optional(),
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
  // Role hint used only when creating a brand-new user. Returning
  // wallets keep their stored role regardless of this field.
  role: z.enum(['NODE_RUNNER', 'COMPUTE_BUYER']).optional(),
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

const PORTAL_URL = process.env.PORTAL_URL || 'https://user.tokenos.ai'

/**
 * Mint a fresh verification token + send the verification email. Used
 * by /register (auto-fire on signup) and /send-verification (manual
 * resend from the unverified-banner button).
 *
 * Returns { token, sent } so callers can decide what to do with a
 * delivery failure. The /register path treats failure as soft (signup
 * still succeeds, user can resend later); /send-verification treats
 * failure as hard (resend button should report 'we tried but Resend
 * dropped it' to the user instead of silently lying that it worked).
 */
async function issueAndSendVerification(
  fastify: FastifyInstance,
  user: { id: string; email: string | null },
): Promise<{ token: string; sent: boolean } | null> {
  if (!user.email) return null
  const token = crypto.randomBytes(32).toString('hex')
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000)

  await fastify.prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationToken: token,
      emailVerificationExpiry: expiry,
    },
  })

  const verifyLink = `${PORTAL_URL}/verify-email?token=${token}`

  const sent = await sendEmail(
    user.email,
    'Verify your email — TokenOS_DeAI',
    `<h2 style="color: #ffffff; margin: 0 0 16px;">Verify Your Email</h2>
     <p style="color: #a1a1aa; line-height: 1.6;">
       Welcome to TokenOS_DeAI. Click the button below to verify your
       email address. Verified accounts can withdraw earnings and
       receive the weekly compute report.
     </p>
     <div style="text-align: center; margin: 32px 0;">
       <a href="${verifyLink}" style="display: inline-block; background: #22c55e; color: #0a0a0f; font-weight: 700; padding: 14px 32px; border-radius: 8px; text-decoration: none; letter-spacing: 0.5px;">
         Verify Email
       </a>
     </div>
     <p style="color: #71717a; font-size: 13px;">
       Or copy this link: <span style="color: #cbd5e1;">${verifyLink}</span>
     </p>
     <p style="color: #71717a; font-size: 13px; margin-top: 16px;">
       This link expires in 24 hours. If you didn't request this, you can safely ignore this email.
     </p>`,
  )
  return { token, sent }
}

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

    const { email, password, role, referralCode } = parsed.data

    // M5.7 anti-abuse: capture the signup IP. Prefer the first hop in
    // X-Forwarded-For (Render + Vercel always set it) and fall back to
    // the raw request socket. Stored on User so the referral
    // attribution path can compare against the referrer's IP.
    const xff = (request.headers['x-forwarded-for'] as string | undefined)
    const signupIp = xff?.split(',')[0]?.trim() || request.ip || null

    try {
      const user = await registerUser(email, password, role, signupIp)
      const accessToken = generateAccessToken(user.id, user.role)
      const refreshToken = await generateRefreshToken(user.id)

      // M5.7 polish: attribute the referral right at signup so the
      // referee NodeRunner row exists with status=ACTIVE before they
      // even land on the dashboard. Only NODE_RUNNER referees attribute;
      // buyer-role signups skip silently (we don't pay commission for
      // referring buyers, that's a different program if we ever add it).
      let referralStatus: string | undefined
      if (referralCode && role === 'NODE_RUNNER') {
        try {
          const refereeRunner = await fastify.prisma.nodeRunner.upsert({
            where: { userId: user.id },
            create: {
              name: user.email?.split('@')[0] ?? 'Node Runner',
              email: user.email,
              walletAddress: user.walletAddress ?? `pending-${user.id}`,
              userId: user.id,
            },
            update: {},
          })
          const attribution = await attributeReferral(
            fastify.prisma,
            refereeRunner.id,
            referralCode,
          )
          referralStatus = attribution.status
          fastify.log.info(
            { userId: user.id, referralCode, status: attribution.status },
            'Referral attribution attempted at signup',
          )
        } catch (refErr) {
          // Never fail the signup over a referral problem. Log and move on.
          fastify.log.warn({ err: refErr, userId: user.id }, 'Referral attribution failed at signup')
          referralStatus = 'ERROR'
        }
      }

      // Fire the verification email automatically right after the
      // account exists. Don't await — SMTP failures shouldn't block
      // the signup response. The user lands on the dashboard, sees the
      // 'verify your email' banner, and can re-fire from there if the
      // email never arrives.
      void issueAndSendVerification(fastify, { id: user.id, email: user.email })

      reply.code(201).send({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
        },
        accessToken,
        refreshToken,
        ...(referralStatus ? { referral: { status: referralStatus } } : {}),
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
      message: `Sign this message to authenticate with TokenOS_DeAI.\n\nNonce: ${nonce}`,
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

    const { address, signature, nonce, role } = parsed.data

    // Verify the signature
    const valid = verifyWalletSignature(address, signature, nonce)
    if (!valid) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid wallet signature',
      })
    }

    // Find or create user. Role only applies to brand-new users.
    const user = await findOrCreateUserByWallet(address, role)
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
      // Dual-identity flags: which surfaces this account can act in.
      // Frontend uses these to decide whether to show the role-aware
      // onboarding callout when a user lands on the "other" side.
      isBuyer: user.isBuyer,
      isNodeRunner: user.isNodeRunner,
      isAdmin: user.isAdmin,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      nodeRunnerId: user.nodeRunner?.id ?? null,
      nodeRunnerName: user.nodeRunner?.name ?? null,
      createdAt: user.createdAt,
    })
  })

  /**
   * POST /v1/portal/auth/add-role — opt in to the other role.
   * Body: { role: 'COMPUTE_BUYER' | 'NODE_RUNNER' }
   *
   * Flips isBuyer or isNodeRunner true on the authenticated user.
   * The primary role label (user.role) is NOT changed, so admin
   * reports keep their existing segmentation. Idempotent: calling
   * twice is a no-op. Returns the refreshed flag set.
   */
  fastify.post('/v1/portal/auth/add-role', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })

    const body = request.body as { role?: string }
    const role = body.role
    if (role !== 'COMPUTE_BUYER' && role !== 'NODE_RUNNER') {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'role must be COMPUTE_BUYER or NODE_RUNNER',
      })
    }

    const updated = await fastify.prisma.user.update({
      where: { id: request.user.userId },
      data: role === 'COMPUTE_BUYER' ? { isBuyer: true } : { isNodeRunner: true },
      select: { isBuyer: true, isNodeRunner: true, isAdmin: true },
    })

    reply.send({
      isBuyer: updated.isBuyer,
      isNodeRunner: updated.isNodeRunner,
      isAdmin: updated.isAdmin,
    })
  })

  /**
   * PATCH /v1/portal/user/wallet — Set or update the buyer/operator's
   * Solana payout wallet. Email-first signups land without a wallet,
   * so this is the single canonical place to attach one later.
   *
   * Side effect: if the user has a linked NodeRunner row, the wallet
   * is also written there so payouts and the deploy flow stop using
   * the `pending-<userId>` placeholder.
   */
  fastify.patch('/v1/portal/user/wallet', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' })

    const body = request.body as { walletAddress?: string }
    const wallet = (body.walletAddress ?? '').trim()

    // Solana base58 addresses are 32-44 chars; we accept that whole
    // range and rely on downstream payout code to do strict base58
    // decoding before any real transfer.
    if (!wallet || wallet.length < 32 || wallet.length > 64 || !/^[A-HJ-NP-Za-km-z1-9]+$/.test(wallet)) {
      return reply.code(400).send({ error: 'Invalid Solana wallet address' })
    }

    // Reject if already taken by another user (unique constraint on both
    // User.walletAddress and NodeRunner.walletAddress).
    const conflict = await fastify.prisma.user.findFirst({
      where: { walletAddress: wallet, NOT: { id: request.user.userId } },
      select: { id: true },
    })
    if (conflict) return reply.code(409).send({ error: 'Wallet already in use by another account' })

    await fastify.prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: request.user!.userId },
        data: { walletAddress: wallet },
      })
      // Sync to NodeRunner if one exists. We use `updateMany` so a
      // missing NodeRunner is a no-op rather than an error.
      await tx.nodeRunner.updateMany({
        where: { userId: request.user!.userId },
        data: { walletAddress: wallet },
      })
    })

    reply.send({ success: true, walletAddress: wallet })
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

    // Wait for the SMTP send result here (unlike the /register auto-
    // fire path which is intentionally fire-and-forget). Operators
    // clicking 'Resend email' on the banner deserve a real answer:
    // if Resend dropped the message — recipient not in audience, daily
    // quota hit, etc. — we want to surface that, not pretend it worked.
    const result = await issueAndSendVerification(fastify, { id: user.id, email: user.email })

    if (!result) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'No email address associated with this account',
      })
    }

    if (!result.sent) {
      return reply.code(502).send({
        error: 'Email delivery failed',
        message: 'The verification token was stored but the email couldn\'t be delivered. If you signed up recently, the sender domain may still be in test mode — check spam, or contact support.',
      })
    }

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

    // Fire EMAIL_VERIFIED notification so the operator gets:
    //   - A row in the bell-icon dropdown saying their email is verified
    //   - A real-time toast via the existing 'notification:new' WS event
    //     (TopHeader listens; pops a toast as soon as the row lands)
    //   - The bell's red unread-count badge bumps by 1
    // Fire-and-forget so a notification table issue can never fail the
    // verification step itself.
    void createNotification(
      user.id,
      'EMAIL_VERIFIED',
      'Email verified',
      'Your email is now verified. Withdrawals and the weekly compute report are unlocked.',
      '/payouts/settings',
    )

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
      'Reset your password — TokenOS_DeAI',
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
