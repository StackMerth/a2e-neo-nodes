import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendEmail, isEmailConfigured } from '../services/email/sender.js'

const SMTP_KEYS = [
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'smtp_enabled',
] as const

const updateSmtpSchema = z.object({
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: z.string().max(255).optional(),
  pass: z.string().max(255).optional(),
  from: z.string().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
})

const testSmtpSchema = z.object({
  to: z.string().email('Invalid email address'),
})

export async function adminSmtpRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)

  /**
   * GET /v1/admin/smtp — Current SMTP config (password masked)
   */
  fastify.get('/v1/admin/smtp', async (_request, reply) => {
    const configs = await fastify.prisma.config.findMany({
      where: { key: { in: [...SMTP_KEYS] } },
    })

    const map: Record<string, string> = {}
    for (const c of configs) map[c.key] = c.value

    const passRaw = map.smtp_pass || ''
    const maskedPass = passRaw.length > 4
      ? '*'.repeat(passRaw.length - 4) + passRaw.slice(-4)
      : passRaw ? '****' : ''

    reply.send({
      host: map.smtp_host || '',
      port: parseInt(map.smtp_port || '587'),
      secure: map.smtp_secure === 'true',
      user: map.smtp_user || '',
      pass: maskedPass,
      from: map.smtp_from || '',
      enabled: map.smtp_enabled !== 'false',
      configured: await isEmailConfigured(),
    })
  })

  /**
   * PATCH /v1/admin/smtp — Update SMTP settings
   */
  fastify.patch('/v1/admin/smtp', async (request, reply) => {
    const parsed = updateSmtpSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map(e => e.message).join(', '),
      })
    }

    const data = parsed.data
    const entries: { key: string; value: string }[] = []

    if (data.host !== undefined) entries.push({ key: 'smtp_host', value: data.host })
    if (data.port !== undefined) entries.push({ key: 'smtp_port', value: String(data.port) })
    if (data.secure !== undefined) entries.push({ key: 'smtp_secure', value: String(data.secure) })
    if (data.user !== undefined) entries.push({ key: 'smtp_user', value: data.user })
    if (data.pass !== undefined) entries.push({ key: 'smtp_pass', value: data.pass })
    if (data.from !== undefined) entries.push({ key: 'smtp_from', value: data.from })
    if (data.enabled !== undefined) entries.push({ key: 'smtp_enabled', value: String(data.enabled) })

    for (const entry of entries) {
      await fastify.prisma.config.upsert({
        where: { key: entry.key },
        update: { value: entry.value },
        create: { key: entry.key, value: entry.value },
      })
    }

    reply.send({ success: true, updated: entries.length })
  })

  /**
   * POST /v1/admin/smtp/test — Send a test email
   */
  fastify.post('/v1/admin/smtp/test', async (request, reply) => {
    const parsed = testSmtpSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: parsed.error.errors.map(e => e.message).join(', '),
      })
    }

    const configured = await isEmailConfigured()
    if (!configured) {
      return reply.code(400).send({
        error: 'Not Configured',
        message: 'SMTP is not configured. Set host and from address first.',
      })
    }

    const sent = await sendEmail(
      parsed.data.to,
      'A²E Engine — Test Email',
      `<h2 style="color: #ffffff; margin: 0 0 16px;">SMTP Configuration Verified</h2>
       <p style="color: #a1a1aa; line-height: 1.6;">
         This is a test email from the A&sup2;E Engine. If you received this, your SMTP settings are configured correctly.
       </p>
       <p style="color: #71717a; font-size: 13px; margin-top: 24px;">
         Sent at ${new Date().toISOString()}
       </p>`,
    )

    if (sent) {
      reply.send({ success: true, message: `Test email sent to ${parsed.data.to}` })
    } else {
      reply.code(500).send({
        error: 'Send Failed',
        message: 'Failed to send test email. Check SMTP credentials and server logs.',
      })
    }
  })
}
