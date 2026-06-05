/**
 * Inspect what RunPod's API actually reports for a rental's SSH info.
 *
 * Use when the portal shows port 22 but `ssh` times out — RunPod
 * community-tier pods commonly expose SSH on a random high port
 * (40000+), and our normalizePod fallback that assumes 22 when the
 * ports[] array doesn't surface a privatePort=22 entry is wrong for
 * those.
 *
 * Render API shell:
 *   pnpm --filter @a2e/api exec tsx scripts/inspect-runpod-pod.ts <computeRequestId>
 *
 * Prints both:
 *   1. What we've persisted on the ExternalRental row (what the
 *      portal is showing the buyer).
 *   2. The raw RunPod API response — including every port mapping —
 *      so we can see what port is really listening.
 */

import { PrismaClient } from '@a2e/database'
import { RunPodClient } from '../src/services/inbound/runpod-adapter.js'

async function main(): Promise<void> {
  const reqIdOrPrefix = process.argv[2]
  if (!reqIdOrPrefix) {
    console.error('Usage: inspect-runpod-pod.ts <computeRequestId | id-prefix>')
    process.exit(1)
  }

  const apiKey = process.env.RUNPOD_API_KEY
  if (!apiKey) {
    console.error('RUNPOD_API_KEY not set on this shell')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  // Resolve the slug-or-full-id to a real ComputeRequest id (same
  // pattern as inspect-rental.ts) so the .pem filename slug works.
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
    console.error(`Ambiguous prefix "${reqIdOrPrefix}" — matches multiple rows. Use a longer prefix.`)
    process.exit(1)
  }
  const reqId = candidates[0]!.id

  const ext = await prisma.externalRental.findFirst({
    where: { computeRequestId: reqId, provider: 'RUNPOD' },
    select: {
      id: true,
      providerInstanceId: true,
      sshHost: true,
      sshPort: true,
      sshUsername: true,
      status: true,
      providerRegion: true,
    },
  })
  if (!ext) {
    console.error(`No RUNPOD ExternalRental for compute request ${reqId}`)
    process.exit(1)
  }

  console.log('=== Persisted on ExternalRental row ===')
  console.log(`  pod id:    ${ext.providerInstanceId}`)
  console.log(`  status:    ${ext.status}`)
  console.log(`  region:    ${ext.providerRegion}`)
  console.log(`  sshHost:   ${ext.sshHost}`)
  console.log(`  sshPort:   ${ext.sshPort}    <-- portal shows this`)
  console.log(`  sshUser:   ${ext.sshUsername}`)
  console.log()

  if (!ext.providerInstanceId) {
    console.error('No providerInstanceId — pod was never created on RunPod')
    process.exit(1)
  }

  const api = new RunPodClient(apiKey)
  let raw: unknown
  try {
    // Hit the same endpoint getPod() uses, but bypass normalisation so
    // we see RunPod's actual response shape.
    raw = await (api as unknown as {
      request: (path: string, method: string) => Promise<unknown>
    }).request(`/pods/${encodeURIComponent(ext.providerInstanceId)}`, 'GET')
  } catch (err) {
    console.error('RunPod /pods/<id> errored:', err instanceof Error ? err.message : err)
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log('=== Raw RunPod API response ===')
  console.log(JSON.stringify(raw, null, 2))
  console.log()

  // Pull out the SSH-relevant bits for quick scanning.
  const r = raw as { publicIp?: string; ports?: Array<{ privatePort?: number; publicPort?: number; isIpPublic?: boolean; ip?: string; type?: string }>; desiredStatus?: string }
  console.log('=== Scan for SSH port ===')
  console.log(`  publicIp:       ${r.publicIp ?? '(null)'}`)
  console.log(`  desiredStatus:  ${r.desiredStatus ?? '(null)'}`)
  if (Array.isArray(r.ports) && r.ports.length > 0) {
    console.log(`  ports[] (${r.ports.length} entries):`)
    for (const p of r.ports) {
      console.log(
        `    privatePort=${p.privatePort ?? '?'} publicPort=${p.publicPort ?? '?'}` +
        ` isIpPublic=${p.isIpPublic ?? '?'} type=${p.type ?? '?'} ip=${p.ip ?? '?'}`,
      )
    }
    // If any port maps from privatePort=22 → publicPort=X, that X is the SSH port.
    const ssh22 = r.ports.find((p) => p.privatePort === 22)
    if (ssh22) {
      console.log()
      console.log(`  >> SSH likely on: ssh -i <key> ubuntu@${r.publicIp ?? ext.sshHost} -p ${ssh22.publicPort}`)
    } else {
      console.log()
      console.log(`  >> No privatePort=22 mapping. Pod may not expose SSH at all,`)
      console.log(`     or RunPod uses a non-standard ssh container port. Compare`)
      console.log(`     with the runpod.io console for this pod id.`)
    }
  } else {
    console.log('  ports[]: (empty or not array — community-tier direct exposure assumed by our normaliser)')
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('inspect-runpod-pod failed:', err)
  process.exit(1)
})
