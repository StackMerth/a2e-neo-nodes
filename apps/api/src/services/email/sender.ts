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

async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const configs = await prisma.config.findMany({
    where: { key: { startsWith: 'smtp_' } },
  })
  const map: Record<string, string> = {}
  for (const c of configs) map[c.key] = c.value

  if (!map.smtp_host || !map.smtp_from) return null

  return {
    host: map.smtp_host,
    port: parseInt(map.smtp_port || '587'),
    secure: map.smtp_secure === 'true',
    user: map.smtp_user || '',
    pass: map.smtp_pass || '',
    from: map.smtp_from,
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
  return config !== null
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const config = await getSmtpConfig()
  if (!config) {
    console.warn('[email] SMTP not configured, skipping email')
    return false
  }

  try {
    const transport = getTransporter(config)
    await transport.sendMail({
      from: config.from,
      to,
      subject,
      html: wrapTemplate(subject, html),
    })
    console.log(`[email] Sent to ${to}: ${subject}`)
    return true
  } catch (error) {
    console.error(`[email] Failed to send to ${to}:`, error)
    return false
  }
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
      <p>A&sup2;E Engine &mdash; compute.tokenos.ai</p>
    </div>
  </div>
</body>
</html>`
}
