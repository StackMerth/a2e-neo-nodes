/**
 * T5h — VoltageGPU read-only inspector.
 *
 *   pnpm --filter @a2e/api voltagegpu:inspect           # priority GPUs
 *   pnpm --filter @a2e/api voltagegpu:inspect --raw     # full catalog
 *   pnpm --filter @a2e/api voltagegpu:inspect --pod <id>
 */
import { VoltageGpuClient, isVoltageGpuConfigured } from '../src/services/inbound/voltagegpu-adapter.js'

async function main(): Promise<void> {
  if (!isVoltageGpuConfigured()) {
    console.log('VOLTAGEGPU_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at https://voltagegpu.com ($5 free credit, no card needed)')
    console.log('  2) Dashboard -> API Keys -> create one')
    console.log('  3) Render -> tokenosdeai-api -> Environment -> add VOLTAGEGPU_API_KEY=<key>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const podIdx = args.indexOf('--pod')
  const podArg = podIdx >= 0 ? args[podIdx + 1] : null

  const client = new VoltageGpuClient()

  if (podArg) {
    const pod = await client.getPod(podArg)
    console.log(`Pod ${pod.id}`)
    console.log(`  status:       ${pod.status}`)
    console.log(`  gpuType:      ${pod.gpuType}`)
    console.log(`  gpuCount:     ${pod.gpuCount}`)
    console.log(`  region:       ${pod.region ?? '(unknown)'}`)
    console.log(`  publicIp:     ${pod.publicIp ?? '(not assigned)'}`)
    console.log(`  sshPort:      ${pod.sshPort ?? '(not exposed)'}`)
    console.log(`  sshUser:      ${pod.sshUser ?? '(default)'}`)
    console.log(`  pricePerHour: ${pod.pricePerHourUsd !== null ? `$${pod.pricePerHourUsd.toFixed(2)}` : '(n/a)'}`)
    console.log(`  attestation:  ${pod.attestationReportUrl ?? '(not exposed)'}`)
    console.log(`  createdAt:    ${pod.createdAt ?? '(unknown)'}`)
    return
  }

  console.log('Calling VoltageGPU API...')
  console.log()

  const offers = await client.listOffers()
  const sorted = [...offers].sort((a, b) => a.pricePerHourUsd - b.pricePerHourUsd)
  const filtered = wantRaw
    ? sorted
    : sorted.filter((o) => /H100|H200|B200/.test(o.gpuModel.toUpperCase()))

  console.log(`Catalog (${filtered.length} of ${offers.length} offers shown):`)
  console.log()
  console.log('  id'.padEnd(28) + 'gpu '.padEnd(8) + 'cnt'.padStart(3) + '  region'.padEnd(10) + '  $/h     cc    stock')
  for (const o of filtered) {
    const price = `$${o.pricePerHourUsd.toFixed(2)}`
    const cc = o.confidential ? 'yes' : 'no'
    const stock = o.available ? 'yes' : 'NO'
    console.log(
      `  ${o.id.padEnd(26)} ${o.gpuModel.padEnd(6)} ${String(o.gpuCount).padStart(3)}  ${o.region.padEnd(8)}  ${price.padStart(7)}  ${cc.padStart(3)}   ${stock}`,
    )
  }
  console.log()
  if (!wantRaw && offers.length > filtered.length) {
    console.log(`(${offers.length - filtered.length} non-H100/H200/B200 offers hidden; --raw to see all)`)
  }

  const pods = await client.listPods()
  console.log()
  console.log(`Account pods: ${pods.length}`)
  for (const p of pods) {
    console.log(`  ${p.id.padEnd(28)} ${p.status.padEnd(12)} ${p.gpuType.padEnd(12)} ${p.publicIp ?? '(no ip)'}:${p.sshPort ?? '?'}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
