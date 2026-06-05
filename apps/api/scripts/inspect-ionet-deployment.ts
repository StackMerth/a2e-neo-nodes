/**
 * Inspect what io.net's API actually returns for a rental — including
 * the canonical ssh_access connect string that our adapter parses
 * (for host + port) but currently throws away the user from.
 *
 * Use when SSH against an io.net rental fails with publickey rejected
 * and you don't yet know the right OS user. The deployment's worker
 * row carries ssh_access which io.net populates with the full SSH
 * command, including the username they actually configured.
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-ionet-deployment.ts <computeRequestId | id-prefix>
 */

import { PrismaClient } from '@a2e/database'
import { IoNetClient } from '../src/services/inbound/ionet-adapter.js'

async function main(): Promise<void> {
  const reqIdOrPrefix = process.argv[2]
  if (!reqIdOrPrefix) {
    console.error('Usage: inspect-ionet-deployment.ts <computeRequestId | id-prefix>')
    process.exit(1)
  }

  const apiKey = process.env.IONET_API_KEY
  if (!apiKey) {
    console.error('IONET_API_KEY not set on this shell')
    process.exit(1)
  }

  const prisma = new PrismaClient()

  const candidates = await prisma.computeRequest.findMany({
    where: { id: { startsWith: reqIdOrPrefix } },
    select: { id: true },
    take: 5,
  })
  if (candidates.length === 0) {
    console.error(`No ComputeRequest matching id prefix "${reqIdOrPrefix}"`)
    process.exit(1)
  }
  if (candidates.length > 1) {
    console.error(`Ambiguous prefix "${reqIdOrPrefix}" — use a longer prefix`)
    process.exit(1)
  }
  const reqId = candidates[0]!.id

  const ext = await prisma.externalRental.findFirst({
    where: { computeRequestId: reqId, provider: 'IONET' },
    select: {
      id: true,
      providerInstanceId: true,
      sshHost: true,
      sshPort: true,
      sshUsername: true,
      status: true,
    },
  })
  if (!ext) {
    console.error(`No IONET ExternalRental for compute request ${reqId}`)
    process.exit(1)
  }

  console.log('=== Persisted on ExternalRental row ===')
  console.log(`  deployment id: ${ext.providerInstanceId}`)
  console.log(`  status:        ${ext.status}`)
  console.log(`  sshHost:       ${ext.sshHost}`)
  console.log(`  sshPort:       ${ext.sshPort}`)
  console.log(`  sshUsername:   ${ext.sshUsername}    <-- portal shows this`)
  console.log()

  if (!ext.providerInstanceId) {
    console.error('No providerInstanceId — deployment never created on io.net')
    process.exit(1)
  }

  const api = new IoNetClient(apiKey)
  let workers
  try {
    workers = await api.getDeploymentVms(ext.providerInstanceId)
  } catch (err) {
    console.error('io.net getDeploymentVms errored:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  console.log('=== io.net workers (normalised) ===')
  console.log(JSON.stringify(workers, null, 2))
  console.log()

  if (workers.length === 0) {
    console.log('(no workers returned — deployment may not be running yet)')
  } else {
    console.log('=== ssh_access strings ===')
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i]!
      console.log(`  worker[${i}]: ${w.sshAccess ?? '(not populated yet)'}`)
    }
    console.log()
    const first = workers[0]!
    if (first.sshAccess) {
      // io.net's ssh_access is typically formatted as:
      //   "ssh user@host -p port"
      //   or "ssh -p port user@host"
      // Extract the user reliably by matching <something>@<something>.
      const userMatch = first.sshAccess.match(/(?:^|\s)([a-zA-Z0-9_-]+)@/)
      if (userMatch) {
        console.log(`  >> Real SSH user per io.net: ${userMatch[1]}`)
        console.log(`     Use: ssh -i <key> ${userMatch[1]}@${first.publicIp} -p ${first.publicPort}`)
      } else {
        console.log(`  (could not parse user from sshAccess string — paste it to me)`)
      }
    }
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('inspect-ionet-deployment failed:', err)
  process.exit(1)
})
