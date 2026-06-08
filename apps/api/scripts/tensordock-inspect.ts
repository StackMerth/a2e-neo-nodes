/**
 * TensorDock read-only inspector.
 *
 * After the 2026-06-08 endpoint-discovery probe (commit b7f71e9) we
 * confirmed the API lives at marketplace.tensordock.com/api/v0 with
 * api_key + api_token query/form auth. Endpoint set was recovered from
 * the caguiclajmg/tensordock-cli Go source. This rewrite hits the real
 * endpoints rather than guessing.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts
 *     -> auth check + live inventory across all locations, sorted by
 *        priority GPUs (H100 / H200 / A100 / L40S / B200).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --raw
 *     -> full /stock/list output including consumer cards.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --gpu H100
 *     -> filter inventory by GPU substring.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --servers
 *     -> list account servers via /list.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --billing
 *     -> account balance via /billing.
 *
 * Env vars:
 *   TENSORDOCK_API_KEY    = Authorization ID (UUID, returned at auth
 *                            creation in the dashboard)
 *   TENSORDOCK_API_TOKEN  = API Token (alphanumeric, shown once at
 *                            auth creation; rotate if leaked)
 */

import {
  TensorDockClient,
  isTensorDockConfigured,
  flattenStock,
} from '../src/services/inbound/tensordock-adapter.js'

const PRIORITY_TOKENS = ['H100', 'H200', 'A100', 'L40S', 'B200']

async function main(): Promise<void> {
  if (!isTensorDockConfigured()) {
    console.log('TENSORDOCK_API_KEY and/or TENSORDOCK_API_TOKEN are not set. Add them to Render API env:')
    console.log('  1) Sign up at https://dashboard.tensordock.com')
    console.log('  2) Developer Settings -> Create Authorization')
    console.log('  3) Render -> a2e-api -> Environment ->')
    console.log('       TENSORDOCK_API_KEY   = <Authorization ID (the UUID)>')
    console.log('       TENSORDOCK_API_TOKEN = <API Token (the alphanumeric secret)>')
    console.log('  4) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantRaw = args.includes('--raw')
  const wantServers = args.includes('--servers')
  const wantBilling = args.includes('--billing')
  const gpuIdx = args.indexOf('--gpu')
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : undefined

  const client = new TensorDockClient()

  // Always confirm credentials work before doing anything else. The
  // /auth/test endpoint is cheap (~50ms) and tells us up-front whether
  // the api_key/api_token pair is valid; if not, every other call will
  // 400 too so abort here with a clear message.
  console.log('Validating credentials via /auth/test ...')
  try {
    const auth = await client.authTest()
    if (!auth.success) {
      console.log(`  -> auth test failed: ${auth.error ?? '(no error message)'}`)
      console.log()
      console.log('Common causes:')
      console.log('  - TENSORDOCK_API_KEY holds the API Token alphanumeric')
      console.log('    instead of the Authorization ID UUID (they are SWAPPED)')
      console.log('  - The authorization was revoked or expired')
      console.log('  - The token was leaked and needs to be regenerated')
      process.exit(1)
    }
    console.log(`  -> auth ok.`)
  } catch (err) {
    console.log(`  -> auth test threw: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  console.log()

  if (wantBilling) {
    console.log('Account billing:')
    const bill = await client.getBilling()
    console.log(`  raw: ${JSON.stringify(bill)}`)
    return
  }

  if (wantServers) {
    console.log('Account servers:')
    const resp = await client.listServers()
    const servers = resp.servers ?? {}
    const ids = Object.keys(servers)
    if (ids.length === 0) {
      console.log('  (none deployed)')
      return
    }
    for (const id of ids) {
      const s = servers[id]!
      const gpu = `${s.gpu_count ?? '?'}x ${s.gpu_model ?? '?'}`
      console.log(
        `  ${id.padEnd(24)} ${(s.status ?? '?').padEnd(14)} ${gpu.padEnd(36)} ${(s.location ?? '?').padEnd(16)} ${(s.ip ?? '-').padEnd(16)}`,
      )
    }
    return
  }

  console.log('Fetching live inventory via /stock/list (unauthenticated)...')
  const stockResp = await client.listStock()
  if (!stockResp.success) {
    console.log(`  -> /stock/list failed: ${stockResp.error ?? '(no error)'}`)
    process.exit(1)
  }
  const rows = flattenStock(stockResp)
  console.log(`  -> ${rows.length} (location, gpu_model) rows total.`)
  console.log()

  let filtered = rows
  if (gpuArg) {
    filtered = rows.filter((r) => r.gpu_model.toLowerCase().includes(gpuArg.toLowerCase()))
    console.log(`Filtered to ${filtered.length} rows matching --gpu ${gpuArg}:`)
  } else if (wantRaw) {
    console.log(`Full catalog (${filtered.length} rows):`)
  } else {
    filtered = rows.filter((r) =>
      PRIORITY_TOKENS.some((tok) => r.gpu_model.toLowerCase().includes(tok.toLowerCase())),
    )
    console.log(`Priority datacenter GPUs (${filtered.length} of ${rows.length} rows):`)
  }

  const sorted = [...filtered].sort((a, b) => {
    if (a.gpu_model !== b.gpu_model) return a.gpu_model.localeCompare(b.gpu_model)
    return b.available_now - a.available_now
  })

  console.log()
  console.log(
    '  location'.padEnd(22)
    + 'gpu_model'.padEnd(36)
    + 'available_now'.padStart(15)
    + 'available_reserve'.padStart(20),
  )
  for (const r of sorted) {
    console.log(
      `  ${r.location.padEnd(20)}  ${r.gpu_model.padEnd(34)}  ${String(r.available_now).padStart(13)}  ${String(r.available_reserve).padStart(17)}`,
    )
  }
  console.log()

  // Summarize total cards available per model across all locations.
  const totalsByModel = new Map<string, { now: number; reserve: number; locs: number }>()
  for (const r of rows) {
    const t = totalsByModel.get(r.gpu_model) ?? { now: 0, reserve: 0, locs: 0 }
    t.now += r.available_now
    t.reserve += r.available_reserve
    t.locs += 1
    totalsByModel.set(r.gpu_model, t)
  }
  const summary = [...totalsByModel.entries()]
    .filter(([m]) =>
      wantRaw || gpuArg
        ? gpuArg ? m.toLowerCase().includes(gpuArg.toLowerCase()) : true
        : PRIORITY_TOKENS.some((tok) => m.toLowerCase().includes(tok.toLowerCase())),
    )
    .sort(([, a], [, b]) => b.now - a.now)

  console.log('Totals by GPU model (across all locations):')
  console.log()
  console.log('  gpu_model'.padEnd(38) + 'total_now'.padStart(10) + 'total_reserve'.padStart(16) + 'locations'.padStart(12))
  for (const [model, t] of summary) {
    console.log(
      `  ${model.padEnd(36)}  ${String(t.now).padStart(8)}  ${String(t.reserve).padStart(14)}  ${String(t.locs).padStart(10)}`,
    )
  }
  console.log()
  console.log('Re-run with --raw to see consumer + non-priority tiers.')
  console.log('Re-run with --gpu <token> to filter by GPU substring (e.g. --gpu h100).')
  console.log('Re-run with --servers to list account deployments.')
  console.log('Re-run with --billing to see account balance.')
}

main().catch((err) => {
  console.error(`tensordock-inspect failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
