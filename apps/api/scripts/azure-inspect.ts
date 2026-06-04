/**
 * T5h — Azure NCCadsH100v5 read-only inspector.
 *
 * Sanity check after setting AZURE_SUBSCRIPTION_ID + AZURE_TENANT_ID
 * + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET in Render env.
 *
 *   pnpm --filter @a2e/api azure:inspect
 *     -> default: tier mappings + region list + existing rentals
 *
 *   pnpm --filter @a2e/api azure:inspect --auth
 *     -> verify auth: fetch token + try a no-op API call
 *
 *   pnpm --filter @a2e/api azure:inspect --vm <rg> <name>
 *     -> poll one VM by resource group + name
 */
import { prisma } from '@a2e/database'
import {
  AzureClient,
  AZURE_NCC_H100_REGIONS,
  isAzureConfigured,
} from '../src/services/inbound/azure-adapter.js'
import { azureTierCoverageSummary } from '../src/services/inbound/azure-tier-mapping.js'

async function main(): Promise<void> {
  if (!isAzureConfigured()) {
    console.log('AZURE env vars not set. Required:')
    console.log('  AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET')
    console.log()
    console.log('Setup steps:')
    console.log('  1) Create Azure subscription at portal.azure.com')
    console.log('  2) Register an app in Azure AD -> create client secret')
    console.log('  3) Grant the service principal Contributor role on the subscription')
    console.log('  4) Copy: subscription ID, tenant ID, client ID, client secret')
    console.log('  5) Inject into Render API env')
    console.log('  6) File Standard_NCC cores quota request (1-4 day SLA)')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const vmIdx = args.indexOf('--vm')
  if (vmIdx >= 0) {
    const rg = args[vmIdx + 1]
    const name = args[vmIdx + 2]
    if (!rg || !name) {
      console.log('--vm requires <resourceGroup> <name>')
      process.exit(1)
    }
    const client = new AzureClient()
    const vm = await client.getInstance(rg, name)
    console.log(`VM ${vm.name}`)
    console.log(`  resourceGroup: ${vm.resourceGroup}`)
    console.log(`  location:      ${vm.location}`)
    console.log(`  status:        ${vm.status}`)
    console.log(`  vmSize:        ${vm.vmSize}`)
    console.log(`  spot:          ${vm.spot}`)
    console.log(`  publicIp:      ${vm.publicIp ?? '(not yet)'}`)
    console.log(`  privateIp:     ${vm.privateIp ?? '(not yet)'}`)
    console.log(`  createdAt:     ${vm.createdAt ?? '(unknown)'}`)
    return
  }

  if (args.includes('--auth')) {
    const client = new AzureClient()
    try {
      // Probe with a known-nonexistent RG/VM. Auth success means we
      // get 404 or 403; auth failure means 401.
      const vm = await client.getInstance('tokenos-auth-probe-rg', 'nonexistent')
      console.log('Unexpected: probe VM exists?', vm)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('404')) {
        console.log('Auth OK: Azure returned 404 for probe VM (expected).')
        console.log('Service principal token + Compute API both working.')
      } else if (msg.includes('403')) {
        console.log('Auth OK at token layer but RBAC denied. Need Contributor role on subscription.')
        console.log('Raw error:', msg)
      } else if (msg.includes('401')) {
        console.log('Auth FAILED. Check AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.')
        console.log('Raw error:', msg)
      } else {
        console.log('Auth probe returned unexpected error:', msg)
      }
    }
    return
  }

  console.log(`AZURE_SUBSCRIPTION_ID: ${process.env.AZURE_SUBSCRIPTION_ID}`)
  console.log()
  console.log('Tier mappings (GpuTier -> Azure vmSize):')
  for (const line of azureTierCoverageSummary()) {
    console.log(`  ${line}`)
  }
  console.log()
  console.log('NCCadsH100v5 regions (rotation candidates):')
  for (const r of AZURE_NCC_H100_REGIONS) {
    console.log(`  ${r}`)
  }
  console.log()

  const rentals = await prisma.externalRental.findMany({
    where: { provider: 'AZURE' },
    orderBy: { launchRequestedAt: 'desc' },
    take: 20,
  })
  console.log(`AZURE ExternalRental rows in DB: ${rentals.length}`)
  for (const r of rentals) {
    console.log(
      `  ${r.id.padEnd(28)} ${r.status.padEnd(8)} ${r.providerInstanceType.padEnd(30)} ${(r.providerRegion ?? '(no region)').padEnd(40)} ${r.sshHost ?? '(no ip)'}  $${r.providerPricePerHourUsd.toFixed(2)}/h`,
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
