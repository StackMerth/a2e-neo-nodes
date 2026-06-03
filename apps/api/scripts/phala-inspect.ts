/**
 * T5f / Milestone 1.6 — Phala read-only inspector.
 *
 * Sanity check after dropping PHALA_API_KEY into Render env. Lists
 * available Phala instance types (the GPU SKUs Phala carries) with
 * current price, plus the CVMs currently allocated on the account.
 *
 *   pnpm --filter @a2e/api phala:inspect
 *     -> default: full instance-type catalog (Phala's GPU SKU list is
 *        small enough that --raw vs default distinction is unneeded)
 *
 *   pnpm --filter @a2e/api phala:inspect --cvm <cvmId>
 *     -> poll one CVM by id (useful during boot or to debug an
 *        unhealthy rental)
 *
 * Aborts cleanly if PHALA_API_KEY is not set.
 */
import { PhalaClient, isPhalaConfigured } from '../src/services/inbound/phala-adapter.js'

async function main(): Promise<void> {
  if (!isPhalaConfigured()) {
    console.log('PHALA_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at https://cloud.phala.network (if not done) and fund the account')
    console.log('  2) Dashboard -> API Keys -> create a project API key (phak_...)')
    console.log('  3) Render -> tokenosdeai-api -> Environment -> add PHALA_API_KEY=<key>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const cvmFlagIdx = args.indexOf('--cvm')
  const cvmArg = cvmFlagIdx >= 0 ? args[cvmFlagIdx + 1] : null

  const client = new PhalaClient()

  if (cvmArg) {
    const cvm = await client.getCvm(cvmArg)
    console.log(`CVM ${cvm.id}`)
    console.log(`  status:       ${cvm.status}`)
    console.log(`  name:         ${cvm.name ?? '(unnamed)'}`)
    console.log(`  gpuType:      ${cvm.gpuTypeId}`)
    console.log(`  gpuCount:     ${cvm.gpuCount}`)
    console.log(`  region:       ${cvm.region ?? '(unknown)'}`)
    console.log(`  publicIp:     ${cvm.publicIp ?? '(not assigned)'}`)
    console.log(`  sshPort:      ${cvm.sshPort ?? '(not exposed)'}`)
    console.log(`  pricePerHour: ${cvm.pricePerHourUsd !== null ? `$${cvm.pricePerHourUsd.toFixed(2)}` : '(n/a)'}`)
    console.log(`  attestation:  ${cvm.attestationReportUrl ?? '(not surfaced yet)'}`)
    console.log(`  createdAt:    ${cvm.createdAt ?? '(unknown)'}`)
    return
  }

  console.log('Calling Phala API...')
  console.log()

  const instanceTypes = await client.listGpuTypes()
  const sorted = [...instanceTypes].sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)

  console.log(`GPU instance catalog (${sorted.length} types):`)
  console.log()
  console.log('  id'.padEnd(22) + 'gpuModel'.padEnd(10) + 'memGB'.padStart(6) + '  price/h  TEE')
  for (const t of sorted) {
    const price = `$${t.pricePerHourUsd.toFixed(2)}`
    const tee = t.teeSupport.join('+')
    console.log(`  ${t.id.padEnd(20)} ${t.gpuModel.padEnd(8)} ${String(t.memoryInGb).padStart(5)}  ${price.padStart(7)}  ${tee}`)
  }
  console.log()

  // Phala doesn't expose live capacity per SKU; flagging "no" would
  // be misleading. listGpuTypes hard-codes hasCurrentStock=true and
  // we rely on createCvm to return 409/503 when stock is exhausted.
  console.log('(Phala does not expose per-SKU live capacity; orderability discovered on createCvm.)')
  console.log()

  const cvms = await client.listCvms()
  console.log(`Account CVMs: ${cvms.length} allocated`)
  if (cvms.length > 0) {
    console.log('  id'.padEnd(30) + 'status'.padEnd(14) + 'gpuType'.padEnd(20) + 'gpuCount'.padStart(10) + '  publicIp:sshPort')
    for (const c of cvms) {
      const ipPort = c.publicIp ? `${c.publicIp}:${c.sshPort ?? '?'}` : '(no ip)'
      console.log(`  ${c.id.padEnd(28)}${c.status.padEnd(14)}${c.gpuTypeId.padEnd(20)}${String(c.gpuCount).padStart(10)}  ${ipPort}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
