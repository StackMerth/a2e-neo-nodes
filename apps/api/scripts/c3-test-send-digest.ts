/**
 * C3 wave 2 helper — render and SEND the digest email using one
 * operator's data to an arbitrary recipient address. Lets you verify
 * the email actually arrives and renders correctly without modifying
 * production NodeRunner.email values.
 *
 * Usage (Render API service Shell):
 *
 *   cd /opt/render/project/src
 *   pnpm --filter @a2e/api c3:test-send-digest <operator-email> <recipient-email>
 *
 * Example:
 *   pnpm --filter @a2e/api c3:test-send-digest asad@m.com you@example.com
 *
 * Differences from digest:run-once:
 *   - Always sends (no eligibility filter on the operator)
 *   - Recipient address is the second arg, not pulled from the
 *     NodeRunner row
 *   - Subject is prefixed [TEST] so it's obvious in the inbox
 *
 * Doesn't touch any production data. Safe to re-run.
 */

import { PrismaClient } from '@a2e/database'
import { calculateForecast } from '../src/services/earnings/forecast.js'
import { calculateNodeUptime } from '../src/services/earnings/uptime-calculator.js'
import { isEmailConfigured, sendEmail } from '../src/services/email/sender.js'
import { renderDigestHtml } from '../src/jobs/weekly-digest.js'

const prisma = new PrismaClient()

async function main() {
  const operatorEmail = process.argv[2]
  const recipientEmail = process.argv[3]

  if (!operatorEmail || !recipientEmail) {
    console.error('Usage: pnpm --filter @a2e/api c3:test-send-digest <operator-email> <recipient-email>')
    process.exit(1)
  }

  if (!(await isEmailConfigured())) {
    console.error('SMTP not configured. Set smtp_host + smtp_from in the Config table first.')
    process.exit(1)
  }

  const nr = await prisma.nodeRunner.findFirst({
    where: { email: operatorEmail },
    select: { id: true, name: true },
  })
  if (!nr) {
    console.error(`No NodeRunner found with email "${operatorEmail}".`)
    process.exit(1)
  }

  console.log(`Building digest using ${nr.name}'s (${operatorEmail}) data...`)

  const forecast = await calculateForecast(prisma, nr.id, 30)
  console.log(`  forecast: $${forecast.projected.toFixed(2)} (${forecast.daysAnalyzed} active days)`)

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const nodes = await prisma.node.findMany({
    where: { nodeRunnerId: nr.id },
    select: { id: true, gpuTier: true, customGpuModel: true },
  })

  const UPTIME_WARNING_THRESHOLD_PCT = parseFloat(process.env.DIGEST_UPTIME_WARN_PCT ?? '90')
  const warnings: Array<{ nodeId: string; gpuTier: string; uptimePct: number }> = []
  for (const node of nodes) {
    const uptimeSeconds = await calculateNodeUptime(prisma, node.id, thirtyDaysAgo, now)
    const periodSeconds = (now.getTime() - thirtyDaysAgo.getTime()) / 1000
    const uptimePct = (uptimeSeconds / periodSeconds) * 100
    if (uptimePct < UPTIME_WARNING_THRESHOLD_PCT) {
      warnings.push({
        nodeId: node.id,
        gpuTier: node.customGpuModel ?? node.gpuTier,
        uptimePct: Math.round(uptimePct * 10) / 10,
      })
    }
  }
  console.log(`  warnings: ${warnings.length} node(s) under ${UPTIME_WARNING_THRESHOLD_PCT}% uptime`)

  const html = renderDigestHtml({
    operatorName: nr.name ?? 'there',
    forecast,
    warnings,
  })

  const subject = `[TEST] Your Compute Weekly Report (preview)`
  console.log('')
  console.log(`Sending to: ${recipientEmail}`)
  const ok = await sendEmail(recipientEmail, subject, html)

  if (ok) {
    console.log('✅ Email sent. Check the recipient inbox (and the spam folder).')
  } else {
    console.error('❌ sendEmail returned false. Check the API logs for the underlying SMTP error.')
    process.exit(1)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
