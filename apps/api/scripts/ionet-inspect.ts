/**
 * T5g — io.net VMaaS read-only inspector.
 *
 * Sanity check after dropping IONET_API_KEY into Render env. Lists
 * available hardware SKUs (GPU instance types) with current price,
 * plus active deployments on the account.
 *
 *   pnpm --filter @a2e/api ionet:inspect
 *     -> priority GPUs (H100 / H200 / B200 / L40S) + deployments
 *
 *   pnpm --filter @a2e/api ionet:inspect --raw
 *     -> full hardware catalog including all consumer SKUs
 *
 *   pnpm --filter @a2e/api ionet:inspect --gpu <name>
 *     -> filter by GPU name substring (e.g. --gpu H100)
 *
 *   pnpm --filter @a2e/api ionet:inspect --deployment <id>
 *     -> poll one deployment by id (deployment + workers)
 *
 *   pnpm --filter @a2e/api ionet:inspect --tdx
 *     -> filter hardware to confidential/TDX-named SKUs only
 *        (once business@io.net allow-lists confidential compute and
 *         those SKUs surface, this lets us see them quickly)
 *
 * Aborts cleanly if IONET_API_KEY is not set.
 */
import { IoNetClient, isIoNetConfigured } from '../src/services/inbound/ionet-adapter.js'

const PRIORITY_TOKENS = ['H100', 'H200', 'B200', 'L40S']
const TDX_TOKENS = ['TDX', 'TEE', 'CONFIDENTIAL', 'CC']

async function main(): Promise<void> {
  if (!isIoNetConfigured()) {
    console.log('IONET_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at https://cloud.io.net (or use existing account)')
    console.log('  2) Visit https://ai.io.net/ai/api-keys -> create a key')
    console.log('  3) Render -> tokenosdeai-api -> Environment -> add IONET_API_KEY=<key>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    console.log()
    console.log('For confidential GPU SKUs (TDX + H100/H200/B200), additionally email')
    console.log('business@io.net to allow-list your account. The standard catalog')
    console.log('works without that, but confidential SKUs require the allow-list.')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const wantTdxOnly = args.includes('--tdx')
  const gpuIdx = args.indexOf('--gpu')
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : null
  const depIdx = args.indexOf('--deployment')
  const depArg = depIdx >= 0 ? args[depIdx + 1] : null

  const client = new IoNetClient()

  if (depArg) {
    const dep = await client.getDeployment(depArg)
    console.log(`Deployment ${dep.id}`)
    console.log(`  name:           ${dep.resourcePrivateName}`)
    console.log(`  status:         ${dep.status}`)
    console.log(`  hardware:       ${dep.hardwareName} (id ${dep.hardwareId})`)
    console.log(`  vms:            ${dep.totalVms}  gpus/vm: ${dep.gpusPerVm}  total gpus: ${dep.totalGpus}`)
    console.log(`  locations:      ${dep.locations.map((l) => l.iso2).join(', ') || '(none)'}`)
    console.log(`  amount paid:    ${dep.amountPaidUsd !== null ? `$${dep.amountPaidUsd.toFixed(2)}` : '(n/a)'}`)
    console.log(`  minutes served: ${dep.computeMinutesServed ?? '(n/a)'}`)
    console.log(`  minutes remain: ${dep.computeMinutesRemaining ?? '(n/a)'}`)
    console.log(`  createdAt:      ${dep.createdAt ?? '(unknown)'}`)
    console.log(`  startedAt:      ${dep.startedAt ?? '(not yet)'}`)
    console.log()

    const vms = await client.getDeploymentVms(depArg)
    console.log(`Workers (${vms.length}):`)
    for (const v of vms) {
      console.log(`  vm ${v.vmId}`)
      console.log(`    status:     ${v.status}`)
      console.log(`    sshAccess:  ${v.sshAccess ?? '(not yet)'}`)
      console.log(`    publicIp:   ${v.publicIp ?? '(not yet)'}:${v.publicPort ?? '?'}`)
      console.log(`    hardware:   ${v.hardware}  brand: ${v.brandName}`)
      console.log(`    uptime:     ${v.uptimePercent ?? '(n/a)'}%`)
      if (v.vmEvents.length > 0) {
        console.log(`    events:`)
        for (const e of v.vmEvents.slice(-5)) {
          console.log(`      ${e.time}  ${e.message}`)
        }
      }
    }
    return
  }

  console.log('Calling io.net VMaaS API...')
  console.log()

  const hardware = await client.listHardware(gpuArg ? { gpu: gpuArg } : undefined)
  const sorted = [...hardware].sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)

  const printRow = (h: typeof sorted[number]): void => {
    const price = `$${h.pricePerHourUsd.toFixed(2)}`
    const storage = `${Math.round(h.storageMb / 1024)}GB`
    console.log(
      `  ${String(h.deployId).padStart(5)} ${h.name.padEnd(38)} ${String(h.numCards).padStart(3)}x  ${String(h.vramPerCardGb).padStart(4)}GB  ${String(h.vcpu).padStart(4)}vCPU ${String(h.memoryGb).padStart(5)}GB  ${storage.padStart(7)}  ${h.location.padEnd(8)}  ${price.padStart(7)}  ${h.supplier}`,
    )
  }

  const header =
    '  id'.padEnd(7) + 'name'.padEnd(39) + 'gpus '.padStart(5) + 'vram '.padStart(8) + 'cpu '.padStart(7) + ' ram '.padStart(8) + 'storage'.padStart(9) + '  region'.padEnd(10) + '  $/h    supplier'

  let filtered = sorted
  if (wantTdxOnly) {
    filtered = sorted.filter((h) =>
      TDX_TOKENS.some((tok) => h.name.toUpperCase().includes(tok)),
    )
    console.log(`TDX/confidential SKUs (${filtered.length}):`)
    if (filtered.length === 0) {
      console.log('  No TDX/confidential SKUs in this account catalog.')
      console.log('  Email business@io.net to allow-list confidential compute,')
      console.log('  then re-run this script. They should appear here.')
    }
  } else if (wantRaw || gpuArg) {
    filtered = sorted
    console.log(`Hardware catalog (${filtered.length} types${gpuArg ? `, filtered by gpu=${gpuArg}` : ''}):`)
  } else {
    filtered = sorted.filter((h) =>
      PRIORITY_TOKENS.some((tok) => h.name.toUpperCase().includes(tok)),
    )
    console.log(`Priority GPUs (H100 / H200 / B200 / L40S) — ${filtered.length} found:`)
  }
  console.log()
  console.log(header)
  for (const h of filtered) printRow(h)
  if (!wantRaw && !gpuArg && !wantTdxOnly) {
    console.log()
    console.log(`Full catalog (${sorted.length} types) hidden — run with --raw to see everything.`)
  }
  console.log()

  // Active deployments — small page since most accounts have <20
  const deps = await client.listDeployments({ pageSize: 20 })
  console.log(`Account deployments: ${deps.length} total`)
  if (deps.length > 0) {
    console.log(
      '  id'.padEnd(40) + 'status'.padEnd(24) + 'hardware'.padEnd(28) + 'gpus'.padStart(5) + '  vms'.padStart(5),
    )
    for (const d of deps) {
      console.log(
        `  ${d.id.padEnd(38)}${d.status.padEnd(24)}${d.hardwareName.padEnd(28)}${String(d.totalGpus).padStart(5)}${String(d.totalVms).padStart(5)}`,
      )
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
