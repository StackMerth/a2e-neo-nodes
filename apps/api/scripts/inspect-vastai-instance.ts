/**
 * Show Vast.ai's raw view of a specific instance, so we can see what
 * stage of boot it's in when our poll worker still reports PENDING.
 *
 * Vast.ai's getInstance returns:
 *   - actual_status: host's current state ("loading", "running", etc)
 *   - cur_state: API's view (sometimes lags actual_status)
 *   - public_ipaddr + ssh_port: populated once the host has finished
 *     the image pull and assigned network
 *   - vm_events (if present): host-reported progress messages
 *
 * Usage on Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-vastai-instance.ts <computeRequestId | slug>
 */

import { PrismaClient } from '@a2e/database'
import { VastAiClient } from '../src/services/inbound/vastai-adapter.js'

async function main(): Promise<void> {
  const reqIdOrPrefix = process.argv[2]
  if (!reqIdOrPrefix) {
    console.error('Usage: inspect-vastai-instance.ts <computeRequestId | slug>')
    process.exit(1)
  }

  const apiKey = process.env.VASTAI_API_KEY
  if (!apiKey) {
    console.error('VASTAI_API_KEY not set on this shell')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  const candidates = await prisma.computeRequest.findMany({
    where: { id: { startsWith: reqIdOrPrefix } },
    select: { id: true },
    take: 5,
  })
  if (candidates.length === 0) {
    console.error(`No ComputeRequest matching "${reqIdOrPrefix}"`)
    process.exit(1)
  }
  if (candidates.length > 1) {
    console.error(`Ambiguous prefix "${reqIdOrPrefix}" — use a longer prefix.`)
    process.exit(1)
  }
  const reqId = candidates[0]!.id

  const ext = await prisma.externalRental.findFirst({
    where: { computeRequestId: reqId, provider: 'VASTAI' },
    select: {
      id: true,
      providerInstanceId: true,
      status: true,
      sshHost: true,
      sshPort: true,
      launchedAt: true,
    },
  })
  if (!ext) {
    console.error(`No VASTAI ExternalRental for compute request ${reqId}`)
    process.exit(1)
  }
  if (!ext.providerInstanceId) {
    console.error(`ExternalRental ${ext.id} has no providerInstanceId — provision never completed.`)
    process.exit(1)
  }

  console.log('=== Persisted on ExternalRental row ===')
  console.log(`  instance id:    ${ext.providerInstanceId}`)
  console.log(`  status:         ${ext.status}`)
  console.log(`  sshHost:        ${ext.sshHost}`)
  console.log(`  sshPort:        ${ext.sshPort}`)
  console.log(`  launchedAt:     ${ext.launchedAt?.toISOString() ?? '(null)'}`)
  console.log()

  const client = new VastAiClient(apiKey)

  // The adapter normalises the response; for a raw view, hit the
  // adapter's private request method directly via type-assert. That's
  // the same path getInstance uses, but we want to see EVERY field
  // Vast.ai returns, not just the normalized subset.
  let raw: unknown
  try {
    raw = await (client as unknown as {
      request: (path: string, method: string) => Promise<unknown>
    }).request(`/instances/${encodeURIComponent(ext.providerInstanceId)}/`, 'GET')
  } catch (err) {
    console.error('Vast.ai instance fetch errored:', err instanceof Error ? err.message : err)
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('=== Raw Vast.ai instance response ===')
  console.log(JSON.stringify(raw, null, 2))
  console.log()

  // Pull out the most useful boot-progress fields.
  const inst = (raw as { instances?: Record<string, unknown> }).instances ?? {}
  console.log('=== Boot progress summary ===')
  console.log(`  actual_status:    ${(inst as { actual_status?: unknown }).actual_status ?? '(missing)'}`)
  console.log(`  cur_state:        ${(inst as { cur_state?: unknown }).cur_state ?? '(missing)'}`)
  console.log(`  intended_status:  ${(inst as { intended_status?: unknown }).intended_status ?? '(missing)'}`)
  console.log(`  public_ipaddr:    ${(inst as { public_ipaddr?: unknown }).public_ipaddr ?? '(not yet)'}`)
  console.log(`  ssh_host:         ${(inst as { ssh_host?: unknown }).ssh_host ?? '(not yet)'}`)
  console.log(`  ssh_port:         ${(inst as { ssh_port?: unknown }).ssh_port ?? '(not yet)'}`)
  console.log(`  status_msg:       ${(inst as { status_msg?: unknown }).status_msg ?? '(none)'}`)
  console.log(`  image_runtype:    ${(inst as { image_runtype?: unknown }).image_runtype ?? '(none)'}`)

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('inspect-vastai-instance failed:', err)
  process.exit(1)
})
