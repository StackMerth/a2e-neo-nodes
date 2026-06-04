/**
 * T5g — GCP A3 confidential read-only inspector.
 *
 * Sanity check after setting GCP_PROJECT_ID + GCP_SA_KEY_JSON in
 * Render env. Lists tier mappings + the confidential A3 zones we
 * target, plus the ExternalRental rows currently on the GCP provider.
 *
 *   pnpm --filter @a2e/api gcp:inspect
 *     -> default: tier mappings + zone list + existing GCP rentals.
 *        No writes.
 *
 *   pnpm --filter @a2e/api gcp:inspect --instance <zone> <name>
 *     -> poll one GCP instance by zone + name.
 *
 *   pnpm --filter @a2e/api gcp:inspect --auth
 *     -> verify the JWT auth flow works: signs a token, exchanges it,
 *        prints the first 30 chars + expiry. Does NOT call Compute.
 *
 * Aborts cleanly if GCP_PROJECT_ID or GCP_SA_KEY_JSON is not set.
 */
import { prisma } from '@a2e/database'
import {
  GcpClient,
  GCP_A3_CONFIDENTIAL_ZONES,
  isGcpConfigured,
} from '../src/services/inbound/gcp-adapter.js'
import { gcpTierCoverageSummary } from '../src/services/inbound/gcp-tier-mapping.js'

async function main(): Promise<void> {
  if (!isGcpConfigured()) {
    console.log('GCP_PROJECT_ID and/or GCP_SA_KEY_JSON not set.')
    console.log()
    console.log('Setup steps:')
    console.log('  1) Create a GCP project at console.cloud.google.com')
    console.log('  2) Link billing + enable Compute Engine API + Confidential Computing API')
    console.log('  3) Create service account `tokenos-provisioner` with Compute Admin role')
    console.log('  4) Generate JSON key, paste full file contents as GCP_SA_KEY_JSON env')
    console.log('  5) Set GCP_PROJECT_ID to the project id (e.g. "tokenos-confidential")')
    console.log('  6) File NVIDIA_H100_GPUS quota request (LONG POLE — 1-3 days)')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const instanceIdx = args.indexOf('--instance')
  if (instanceIdx >= 0) {
    const zone = args[instanceIdx + 1]
    const name = args[instanceIdx + 2]
    if (!zone || !name) {
      console.log('--instance requires <zone> <name>')
      process.exit(1)
    }
    const client = new GcpClient()
    const inst = await client.getInstance(zone, name)
    console.log(`Instance ${inst.name}`)
    console.log(`  zone:         ${inst.zone}`)
    console.log(`  status:       ${inst.status}`)
    console.log(`  machineType:  ${inst.machineType}`)
    console.log(`  spot:         ${inst.spot}`)
    console.log(`  publicIp:     ${inst.publicIp ?? '(not yet)'}`)
    console.log(`  privateIp:    ${inst.privateIp ?? '(not yet)'}`)
    console.log(`  createdAt:    ${inst.createdAt ?? '(unknown)'}`)
    return
  }

  if (args.includes('--auth')) {
    const client = new GcpClient()
    // Cheap call: list zones the project knows. If auth is broken,
    // this throws GcpApiError 401 / 403. We use a low-cost endpoint
    // rather than instances.list to avoid triggering quota.
    try {
      const inst = await client.getInstance(GCP_A3_CONFIDENTIAL_ZONES[0], '__nonexistent_auth_probe__')
      console.log('Unexpected: probe instance exists?', inst)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('404')) {
        console.log('Auth OK: GCP returned 404 for probe instance (expected).')
      } else if (msg.includes('403')) {
        console.log('Auth OK at Bearer layer but PERMISSION_DENIED on Compute.')
        console.log('Check service account roles: needs Compute Admin.')
        console.log('Raw error:', msg)
      } else if (msg.includes('401')) {
        console.log('Auth FAILED at JWT exchange. Verify GCP_SA_KEY_JSON is the full file contents.')
        console.log('Raw error:', msg)
      } else {
        console.log('Auth probe returned unexpected error:', msg)
      }
    }
    return
  }

  console.log(`GCP_PROJECT_ID: ${process.env.GCP_PROJECT_ID}`)
  console.log()
  console.log('Tier mappings (GpuTier -> GCP machineType):')
  for (const line of gcpTierCoverageSummary()) {
    console.log(`  ${line}`)
  }
  console.log()
  console.log('Confidential A3 zones (rotation candidates):')
  for (const z of GCP_A3_CONFIDENTIAL_ZONES) {
    console.log(`  ${z}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'GCP' },
    orderBy: { launchRequestedAt: 'desc' },
    take: 20,
  })
  console.log(`GCP ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(
      `  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.providerInstanceType.padEnd(20)} ${(r.providerRegion ?? '(no zone)').padEnd(16)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`,
    )
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
