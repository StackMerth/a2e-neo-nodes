/**
 * Force one immediate poll of pending SHADEFORM ExternalRentals.
 *
 * Useful when the bullmq tick worker hasn't deployed yet but you have
 * a stuck rental sitting in PROVISIONING_EXTERNAL while Shadeform's
 * side has already gone active. Calls runShadeFormPollTick once and
 * exits.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/shadeform-force-poll.ts
 */
import { PrismaClient } from '@a2e/database'
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import { runShadeFormPollTick } from '../src/jobs/shadeform-poll.js'

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  // Dummy socket server so the worker's io.emit calls don't crash.
  // We don't connect any client; emits go to /dev/null.
  const httpServer = createServer()
  const io = new Server(httpServer)
  try {
    console.log('Running one immediate shadeform-poll tick ...')
    await runShadeFormPollTick(prisma, io)
    console.log('Tick complete. Check the portal — promoted rentals should show SSH now.')
  } finally {
    await prisma.$disconnect()
    io.close()
    httpServer.close()
  }
}

main().catch((err) => {
  console.error('shadeform-force-poll failed:', err)
  process.exit(1)
})
