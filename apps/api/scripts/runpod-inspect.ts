/**
 * T5e — RunPod read-only inspector.
 *
 * Sanity check after dropping RUNPOD_API_KEY into Render env. Lists
 * available GPU types with current price + capacity, and shows the
 * pods currently allocated on the account.
 *
 *   pnpm --filter @a2e/api runpod:inspect
 *     -> default: priority GPU types (H100 / H200 / B200 / L40S)
 *        emphasized, plus current pod inventory
 *
 *   pnpm --filter @a2e/api runpod:inspect --raw
 *     -> dump every GPU type RunPod offers, including consumer SKUs
 *
 *   pnpm --filter @a2e/api runpod:inspect --pod <podId>
 *     -> poll one pod by id (useful during boot or to debug an
 *        unhealthy rental)
 *
 * Aborts cleanly if RUNPOD_API_KEY is not set.
 */
import { RunPodClient, isRunPodConfigured } from '../src/services/inbound/runpod-adapter.js'

const PRIORITY_TOKENS = ['H100', 'H200', 'B200', 'L40S']

async function main(): Promise<void> {
  if (!isRunPodConfigured()) {
    console.log('RUNPOD_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at runpod.io (if not done) and fund the account')
    console.log('  2) Settings -> API Keys -> Create API Key')
    console.log('  3) Render -> tokenosdeai-api -> Environment -> add RUNPOD_API_KEY=<key>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const podFlagIdx = args.indexOf('--pod')
  const podArg = podFlagIdx >= 0 ? args[podFlagIdx + 1] : null

  const client = new RunPodClient()

  if (podArg) {
    const pod = await client.getPod(podArg)
    console.log(`Pod ${pod.id}`)
    console.log(`  status:       ${pod.status}`)
    console.log(`  name:         ${pod.name ?? '(unnamed)'}`)
    console.log(`  gpuType:      ${pod.gpuTypeId}`)
    console.log(`  gpuCount:     ${pod.gpuCount}`)
    console.log(`  region:       ${pod.region ?? '(unknown)'}`)
    console.log(`  publicIp:     ${pod.publicIp ?? '(not assigned)'}`)
    console.log(`  sshPort:      ${pod.sshPort ?? '(not exposed)'}`)
    console.log(`  pricePerHour: ${pod.pricePerHourUsd !== null ? `$${pod.pricePerHourUsd.toFixed(2)}` : '(n/a)'}`)
    console.log(`  createdAt:    ${pod.createdAt ?? '(unknown)'}`)
    return
  }

  console.log('Calling RunPod API...')
  console.log()

  const gpuTypes = await client.listGpuTypes()
  const sorted = [...gpuTypes].sort((a, b) => {
    // Sort by price ascending, nulls last
    if (a.lowestPricePerHourUsd === null && b.lowestPricePerHourUsd === null) return 0
    if (a.lowestPricePerHourUsd === null) return 1
    if (b.lowestPricePerHourUsd === null) return -1
    return a.lowestPricePerHourUsd - b.lowestPricePerHourUsd
  })

  const printRow = (t: typeof sorted[number]): void => {
    const lowest = t.lowestPricePerHourUsd !== null ? `$${t.lowestPricePerHourUsd.toFixed(2)}` : '-'
    const secure = t.securePricePerHourUsd !== null ? `$${t.securePricePerHourUsd.toFixed(2)}` : '-'
    const community = t.communityPricePerHourUsd !== null ? `$${t.communityPricePerHourUsd.toFixed(2)}` : '-'
    const stock = t.hasCurrentStock ? 'yes' : 'NO'
    // ID is what you pass to --type; display name is what RunPod's
    // console shows. They often differ slightly (e.g. id "NVIDIA H200
    // NVL 141GB" -> display "H200 NVL"), so we print both.
    console.log(`  ${t.id.padEnd(48)} ${t.displayName.padEnd(22)} ${String(t.memoryInGb).padStart(5)}  ${lowest.padStart(7)} ${secure.padStart(7)} ${community.padStart(7)}  ${stock}`)
  }

  const header = '  id'.padEnd(50) + ' displayName'.padEnd(23) + 'memGB'.padStart(6) + '   lowest  secure    comm  stock'

  if (wantRaw) {
    console.log(`Full GPU type catalog (${sorted.length} types):`)
    console.log()
    console.log(header)
    for (const t of sorted) printRow(t)
  } else {
    const priority = sorted.filter((t) =>
      PRIORITY_TOKENS.some((tok) => t.displayName.includes(tok) || t.id.includes(tok)),
    )
    console.log(`Priority types (H100 / H200 / B200 / L40S) — ${priority.length} found:`)
    console.log()
    console.log(header)
    for (const t of priority) printRow(t)
    console.log()
    console.log(`Full catalogue (${sorted.length} types) hidden — run with --raw to dump everything.`)
  }
  console.log()

  const pods = await client.listPods()
  console.log(`Account pods: ${pods.length} allocated`)
  if (pods.length > 0) {
    console.log('  id'.padEnd(30) + 'status'.padEnd(12) + 'gpuType'.padEnd(35) + 'gpuCount'.padStart(10) + '  publicIp:sshPort')
    for (const p of pods) {
      const ipPort = p.publicIp ? `${p.publicIp}:${p.sshPort ?? '?'}` : '(no ip)'
      console.log(`  ${p.id.padEnd(28)}${p.status.padEnd(12)}${p.gpuTypeId.padEnd(35)}${String(p.gpuCount).padStart(10)}  ${ipPort}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
