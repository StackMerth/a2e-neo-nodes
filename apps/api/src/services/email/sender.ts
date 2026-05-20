import nodemailer from 'nodemailer'
import type Nodemailer from 'nodemailer'
import { prisma } from '@a2e/database'

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

let transporter: Nodemailer.Transporter | null = null
let lastConfigHash = ''

/**
 * In-memory health state for the email transport. Surfaced on
 * /health/detailed so admins can see at a glance whether emails are
 * actually being delivered. Reset on process restart.
 */
interface EmailHealth {
  configured: boolean
  lastSendSucceededAt: Date | null
  lastSendFailedAt: Date | null
  lastFailureReason: string | null
  consecutiveFailures: number
  totalSent: number
  totalFailed: number
  warningLogged: boolean
}

const health: EmailHealth = {
  configured: false,
  lastSendSucceededAt: null,
  lastSendFailedAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
  totalSent: 0,
  totalFailed: 0,
  warningLogged: false,
}

// Placeholder sentinel values that the seed / install scripts leave in
// Config rows so deploys don't crash, but which must NOT be treated as
// real SMTP credentials. Without this guard, isEmailConfigured()
// returns true on a placeholder hostname and every digest tick fails
// at DNS resolution (getaddrinfo ENOTFOUND ...), flooding the logs.
const PLACEHOLDER_VALUES = new Set([
  'NEEDS_OPERATOR_CONFIG',
  'CHANGEME',
  'PLACEHOLDER',
  'TODO',
  'CONFIGURE_ME',
])

function isRealValue(v: string | undefined | null): boolean {
  if (!v) return false
  const trimmed = v.trim()
  if (!trimmed) return false
  if (PLACEHOLDER_VALUES.has(trimmed.toUpperCase())) return false
  return true
}

async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const configs = await prisma.config.findMany({
    where: { key: { startsWith: 'smtp_' } },
  })
  const map: Record<string, string> = {}
  for (const c of configs) map[c.key] = c.value

  // Treat sentinel placeholder strings the same as missing config so
  // the worker no-ops cleanly instead of DNS-failing on every tick.
  if (!isRealValue(map.smtp_host) || !isRealValue(map.smtp_from)) {
    return null
  }

  return {
    host: map.smtp_host!,
    port: parseInt(map.smtp_port || '587'),
    secure: map.smtp_secure === 'true',
    user: isRealValue(map.smtp_user) ? map.smtp_user! : '',
    pass: isRealValue(map.smtp_pass) ? map.smtp_pass! : '',
    from: map.smtp_from!,
  }
}

function getTransporter(config: SmtpConfig): Nodemailer.Transporter {
  const hash = JSON.stringify(config)
  if (transporter && lastConfigHash === hash) return transporter

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  })
  lastConfigHash = hash
  return transporter
}

export async function isEmailConfigured(): Promise<boolean> {
  const config = await getSmtpConfig()
  health.configured = config !== null
  return config !== null
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const config = await getSmtpConfig()
  if (!config) {
    health.configured = false
    health.totalFailed++
    health.consecutiveFailures++
    health.lastSendFailedAt = new Date()
    health.lastFailureReason = 'SMTP not configured (smtp_host or smtp_from missing in Config table)'

    // Log only once per process so we don't flood pm2 logs every notification.
    if (!health.warningLogged) {
      console.error(
        '[email] SMTP unconfigured. Add smtp_host, smtp_from (and optionally smtp_user/smtp_pass/smtp_port/smtp_secure) ' +
          'to the Config table or via the admin settings page. Email notifications will not be delivered until then. ' +
          'See /health/detailed for current state.',
      )
      health.warningLogged = true
    }
    return false
  }

  health.configured = true

  try {
    const transport = getTransporter(config)
    await transport.sendMail({
      from: config.from,
      to,
      subject,
      html: wrapTemplate(subject, html),
    })
    health.totalSent++
    health.consecutiveFailures = 0
    health.lastSendSucceededAt = new Date()
    health.lastFailureReason = null
    console.log(`[email] Sent to ${to}: ${subject}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown SMTP error'
    health.totalFailed++
    health.consecutiveFailures++
    health.lastSendFailedAt = new Date()
    health.lastFailureReason = message

    // Always log delivery failures at error level — these mean an email
    // actually didn't reach the recipient, which is more serious than
    // "SMTP not configured at all".
    console.error(`[email] Delivery failed to ${to} (subject: "${subject}"): ${message}`)
    return false
  }
}

/**
 * Snapshot of the email transport health. Consumed by the
 * /health/detailed endpoint so admins can surface email-delivery state
 * in operational dashboards.
 */
export function getEmailHealth(): {
  status: 'ok' | 'unconfigured' | 'degraded'
  configured: boolean
  consecutiveFailures: number
  totalSent: number
  totalFailed: number
  lastSendSucceededAt: string | null
  lastSendFailedAt: string | null
  lastFailureReason: string | null
} {
  let status: 'ok' | 'unconfigured' | 'degraded'
  if (!health.configured) {
    status = 'unconfigured'
  } else if (health.consecutiveFailures >= 3) {
    status = 'degraded'
  } else {
    status = 'ok'
  }
  return {
    status,
    configured: health.configured,
    consecutiveFailures: health.consecutiveFailures,
    totalSent: health.totalSent,
    totalFailed: health.totalFailed,
    lastSendSucceededAt: health.lastSendSucceededAt?.toISOString() ?? null,
    lastSendFailedAt: health.lastSendFailedAt?.toISOString() ?? null,
    lastFailureReason: health.lastFailureReason,
  }
}

/** Test-only — reset the health snapshot between unit tests. */
export function _resetEmailHealthForTests(): void {
  health.configured = false
  health.lastSendSucceededAt = null
  health.lastSendFailedAt = null
  health.lastFailureReason = null
  health.consecutiveFailures = 0
  health.totalSent = 0
  health.totalFailed = 0
  health.warningLogged = false
}

function wrapTemplate(title: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #ffffff; margin: 0; padding: 0;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <span style="font-size: 24px; font-weight: 700;">A<sup style="color: #22c55e;">2</sup>E Engine</span>
      <p style="color: #71717a; font-size: 14px; margin-top: 4px;">TokenOS Compute Platform</p>
    </div>
    <div style="background: #111118; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 32px;">
      ${content}
    </div>
    <div style="text-align: center; margin-top: 32px; color: #71717a; font-size: 12px;">
      <p>A&sup2;E Engine &mdash; user.tokenos.ai</p>
    </div>
  </div>
</body>
</html>`
}
