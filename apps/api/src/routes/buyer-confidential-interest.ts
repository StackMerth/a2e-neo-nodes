/**
 * Confidential compute waitlist endpoints.
 *
 * Active when CONFIDENTIAL_COMPUTE_UI_MODE=waitlist. Lets the buyer
 * UI capture expressions of interest in confidential GPU TEE compute
 * without taking payment when no supplier currently has reliable
 * capacity.
 *
 * Why this exists: prior to this, the buyer request form let the
 * buyer check "Require confidential compute" and submit a paid
 * ComputeRequest. With no supplier currently online (Phala h200
 * exhausted, GCP A3 quota pending, Azure signup blocked), the
 * request would land in WAITING_ON_CAPACITY indefinitely while the
 * buyer's balance stayed debited. This endpoint short-circuits that
 * trap by capturing interest WITHOUT debiting.
 *
 * Routes:
 *   GET  /v1/buyer/compute/confidential-mode
 *     Returns the current CONFIDENTIAL_COMPUTE_UI_MODE so the portal
 *     can render the right UI ('active' | 'waitlist' | 'hidden').
 *
 *   POST /v1/buyer/compute/confidential-interest
 *     Records an interest expression. Sends admin notification +
 *     buyer confirmation email. No balance debited, no
 *     ComputeRequest created.
 *
 * Mode values:
 *   active   - normal provisioning (default; restores when supply lands)
 *   waitlist - captures interest, no payment, no provisioning
 *   hidden   - buyer UI hides the confidential checkbox entirely
 *
 * The GET endpoint is also used as a defense-in-depth check by the
 * regular /v1/buyer/compute/request endpoint: when waitlist or
 * hidden mode is active and preferConfidential=true comes in, the
 * request endpoint rejects with 422 instructing the buyer to use
 * the waitlist flow.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'

export type ConfidentialComputeUiMode = 'active' | 'waitlist' | 'hidden'

/**
 * Read the current UI mode from env. Defaults to 'active' so existing
 * deploys without the env set keep the prior behavior. Render env on
 * 2026-06-04 sets this to 'waitlist' to gate the trap.
 */
export function getConfidentialComputeUiMode(): ConfidentialComputeUiMode {
  const raw = (process.env.CONFIDENTIAL_COMPUTE_UI_MODE ?? '').trim().toLowerCase()
  if (raw === 'waitlist' || raw === 'hidden') return raw
  return 'active'
}

const interestSchema = z.object({
  // Required: how we contact the buyer when capacity lands.
  email: z.string().email().max(320),
  // Optional fields below — best-effort context for prioritizing
  // supplier onboarding. None gate the submission.
  gpuTier: z.enum(['H100', 'H200', 'L40S', 'B200', 'B300', 'GB300', 'CONSUMER', 'RTX_4090', 'RTX_3090']).optional(),
  gpuCount: z.number().int().min(1).max(64).optional(),
  workloadType: z.string().max(200).optional(),
  expectedHours: z.number().int().min(1).max(100_000).optional(),
  timelineWeeks: z.number().int().min(0).max(104).optional(),
  notes: z.string().max(2_000).optional(),
})

export async function buyerConfidentialInterestRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * GET /v1/buyer/compute/confidential-mode
   *
   * Portal hits this on the request page to know which UI to render.
   * Returns one of: { mode: 'active' | 'waitlist' | 'hidden' }.
   */
  fastify.get('/v1/buyer/compute/confidential-mode', async (_request, reply) => {
    return reply.send({ mode: getConfidentialComputeUiMode() })
  })

  /**
   * POST /v1/buyer/compute/confidential-interest
   *
   * Captures the buyer's interest. Idempotent on (userId, recent
   * createdAt) so a buyer who refreshes + resubmits doesn't double
   * up the admin's inbox. Returns 200 with the interest id and a
   * thank-you message either way.
   *
   * Behavior gates:
   *   - waitlist mode: accepts and processes the interest
   *   - active mode: returns 422 telling buyer to use regular flow
   *   - hidden mode: returns 404 so the UI doesn't leak the endpoint
   */
  fastify.post('/v1/buyer/compute/confidential-interest', async (request, reply) => {
    const mode = getConfidentialComputeUiMode()
    if (mode === 'hidden') {
      return reply.code(404).send({ error: 'Not Found' })
    }
    if (mode === 'active') {
      return reply.code(422).send({
        error: 'Unprocessable Entity',
        message:
          'Confidential compute is currently available for direct provisioning. Submit a regular ComputeRequest with preferConfidential=true instead of using the waitlist.',
      })
    }

    const parsed = interestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      })
    }

    const userId = request.user!.userId
    const data = parsed.data

    // Idempotency: skip if the same user filed an interest in the
    // last 24 hours. Surface the existing id so the buyer UI shows a
    // consistent thank-you state instead of leaking duplicate rows.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const existing = await fastify.prisma.confidentialInterest.findFirst({
      where: { userId, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    })
    if (existing) {
      return reply.send({
        id: existing.id,
        alreadyOnWaitlist: true,
        message:
          "You're already on the confidential compute waitlist. We'll email you the moment capacity is available.",
      })
    }

    const interest = await fastify.prisma.confidentialInterest.create({
      data: {
        userId,
        email: data.email,
        gpuTier: data.gpuTier,
        gpuCount: data.gpuCount,
        workloadType: data.workloadType,
        expectedHours: data.expectedHours,
        timelineWeeks: data.timelineWeeks,
        notes: data.notes,
      },
      select: { id: true },
    })

    // Fire-and-forget email notifications. If SMTP is misconfigured
    // the email layer logs and continues; we never block the form
    // submission on email delivery.
    if (await isEmailConfigured()) {
      const adminEmail = process.env.CONFIDENTIAL_INTEREST_NOTIFY_EMAIL?.trim()
      if (adminEmail) {
        void sendEmail(
          adminEmail,
          `[TokenOS] New confidential compute interest from ${data.email}`,
          renderAdminEmail({
            interestId: interest.id,
            email: data.email,
            gpuTier: data.gpuTier,
            gpuCount: data.gpuCount,
            workloadType: data.workloadType,
            expectedHours: data.expectedHours,
            timelineWeeks: data.timelineWeeks,
            notes: data.notes,
          }),
        )
      }
      void sendEmail(
        data.email,
        'TokenOS — your confidential compute waitlist confirmation',
        renderBuyerEmail({ email: data.email }),
      )
    }

    return reply.send({
      id: interest.id,
      alreadyOnWaitlist: false,
      message:
        "Thanks. You're on the confidential compute waitlist. We'll email you the moment capacity is available.",
    })
  })
}

function renderAdminEmail(args: {
  interestId: string
  email: string
  gpuTier?: string
  gpuCount?: number
  workloadType?: string
  expectedHours?: number
  timelineWeeks?: number
  notes?: string
}): string {
  const row = (label: string, value: string | number | undefined): string => {
    if (value === undefined || value === null || value === '') return ''
    return `<tr><td style="padding:6px 12px;color:#666;">${label}</td><td style="padding:6px 12px;">${String(value)}</td></tr>`
  }
  return `
    <h2 style="font-family:system-ui;">New confidential compute interest</h2>
    <p>A buyer just joined the confidential compute waitlist. Details below.</p>
    <table style="font-family:system-ui;border-collapse:collapse;border:1px solid #eee;">
      ${row('Interest ID', args.interestId)}
      ${row('Email', args.email)}
      ${row('GPU tier', args.gpuTier)}
      ${row('GPU count', args.gpuCount)}
      ${row('Workload', args.workloadType)}
      ${row('Expected hours / month', args.expectedHours)}
      ${row('Timeline (weeks)', args.timelineWeeks)}
      ${row('Notes', args.notes)}
    </table>
    <p style="color:#666;font-size:12px;">
      Auto-sent from buyer-confidential-interest.ts. Flip
      CONFIDENTIAL_COMPUTE_UI_MODE=active when supply is online and
      ping this buyer to invite them to provision.
    </p>
  `.trim()
}

function renderBuyerEmail(args: { email: string }): string {
  return `
    <p style="font-family:system-ui;font-size:15px;">Hi,</p>
    <p style="font-family:system-ui;font-size:15px;">
      Thanks for your interest in TokenOS confidential GPU compute.
      We've added <strong>${args.email}</strong> to the waitlist.
    </p>
    <p style="font-family:system-ui;font-size:15px;">
      We're actively onboarding suppliers that combine Intel TDX (or AMD SEV-SNP) with NVIDIA Hopper CC mode. The moment we have reliable capacity, we'll email you with instructions to provision.
    </p>
    <p style="font-family:system-ui;font-size:15px;">
      If your timeline shifts or you'd like to update anything, reply to this email.
    </p>
    <p style="font-family:system-ui;font-size:15px;">
      Thanks,<br/>
      TokenOS Team
    </p>
    <p style="color:#666;font-size:12px;font-family:system-ui;">
      You received this because you joined the confidential compute waitlist at market.tokenos.ai.
    </p>
  `.trim()
}
