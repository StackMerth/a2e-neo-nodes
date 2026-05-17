/**
 * Defense-in-depth: null the stale SettlementConfig.payerPrivateKey row.
 *
 * Background: pre-M1, the Solana payer private key was stored in plain
 * text in the SettlementConfig table. After M1.7 the engine reads from
 * the SOLANA_PAYER_KEY env var exclusively (see engine.ts +
 * services/payment/solana.ts). The old DB column is unused, but the
 * historical value still sits in the row — anyone with read access to
 * the DB (a backup leak, a debugging accident, a future ORM bug) could
 * pull it and drain the wallet.
 *
 * This script blanks the column so the env var becomes the single
 * source of truth. Idempotent — running it twice does nothing on the
 * second run.
 *
 * Usage (from Render API web shell — the service named 'a2e-api'):
 *
 *   cd /opt/render/project/src/apps/api
 *   pnpm null:payer-key
 *
 * Or directly with tsx:
 *
 *   npx tsx scripts/null-payer-key.ts
 */

import { PrismaClient } from '@a2e/database'

const prisma = new PrismaClient()

async function main() {
  const before = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
    select: { id: true, payerPrivateKey: true },
  })

  if (!before) {
    console.log('No SettlementConfig row found (id=default). Nothing to clear.')
    return
  }

  if (before.payerPrivateKey === null) {
    console.log('payerPrivateKey is already NULL. Nothing to do.')
    return
  }

  const keyPreview = before.payerPrivateKey.slice(0, 8) + '...'
  console.log(`Found payerPrivateKey: ${keyPreview} (${before.payerPrivateKey.length} chars). Nulling...`)

  const after = await prisma.settlementConfig.update({
    where: { id: 'default' },
    data: { payerPrivateKey: null },
  })

  if (after.payerPrivateKey !== null) {
    console.error('Unexpected: payerPrivateKey is not null after update. Aborting.')
    process.exit(1)
  }

  console.log('payerPrivateKey cleared. Env var SOLANA_PAYER_KEY is now the single source of truth.')
}

main()
  .catch((err) => {
    console.error('Script failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
