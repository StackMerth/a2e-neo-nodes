/**
 * C3 wave 2 helper — write SMTP credentials into the Config table so
 * the digest worker (and every other transactional email path) can
 * actually deliver mail. Replaces any existing rows with the same keys.
 *
 * Usage (Render API service Shell):
 *
 *   pnpm --filter @a2e/api c3:set-smtp \
 *     --host smtp.sendgrid.net \
 *     --from noreply@yourdomain.com \
 *     --user apikey \
 *     --pass SG.xxxx-your-api-key-xxxx \
 *     [--port 587] [--secure false]
 *
 * Each flag takes the next token as its value. Order doesn't matter.
 * Required: --host, --from. Optional: --user, --pass, --port, --secure.
 *
 * After running, verify with:
 *   pnpm --filter @a2e/api c3:test-send-digest <operator-email> <recipient>
 *
 * To clear (revert to "SMTP not configured" state):
 *   pnpm --filter @a2e/api c3:set-smtp --clear
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

function parseFlags(argv: string[]): Record<string, string> | { clear: true } {
  if (argv.includes('--clear')) return { clear: true }
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) continue
    out[token.slice(2)] = next
    i++
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const flags = parseFlags(args)

  if ('clear' in flags && flags.clear === true) {
    const result = await prisma.config.deleteMany({
      where: { key: { startsWith: 'smtp_' } },
    })
    console.log(`Cleared ${result.count} smtp_* config row(s). SMTP is now unconfigured.`)
    return
  }

  const f = flags as Record<string, string>
  if (!f.host || !f.from) {
    console.error('Required flags: --host <smtp host>, --from <sender email>')
    console.error('Optional: --user <user>, --pass <password>, --port <port>, --secure <true|false>')
    console.error('Or use --clear to remove all smtp_* config rows.')
    process.exit(1)
  }

  const writes: Array<{ key: string; value: string }> = [
    { key: 'smtp_host', value: f.host },
    { key: 'smtp_from', value: f.from },
  ]
  if (f.user) writes.push({ key: 'smtp_user', value: f.user })
  if (f.pass) writes.push({ key: 'smtp_pass', value: f.pass })
  if (f.port) writes.push({ key: 'smtp_port', value: f.port })
  if (f.secure) writes.push({ key: 'smtp_secure', value: f.secure })

  for (const w of writes) {
    await prisma.config.upsert({
      where: { key: w.key },
      create: { key: w.key, value: w.value },
      update: { value: w.value },
    })
  }

  console.log(`Wrote ${writes.length} smtp_* config row(s):`)
  for (const w of writes) {
    // Mask passwords so terminal scrollback doesn't leak the secret.
    const value = w.key === 'smtp_pass' ? '*'.repeat(Math.min(8, w.value.length)) : w.value
    console.log(`  ${w.key.padEnd(12)} = ${value}`)
  }
  console.log('')
  console.log('Test delivery with:')
  console.log(`  pnpm --filter @a2e/api c3:test-send-digest <operator-email> <your-real-inbox>`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
