/**
 * TensorDock read-only inspector.
 *
 * Real endpoint set (ground truth from alx/tensordock_deploy main.py,
 * verified by /auth/test 200 OK on 2026-06-08):
 *
 *   POST /api/v0/auth/test               form body; credential check
 *   GET  /api/v0/client/deploy/hostnodes NO AUTH; per-host inventory
 *   POST /api/v0/client/list             form body; my deployed servers
 *   POST /api/v0/client/get/single       form body + server uuid
 *   POST /api/v0/client/deploy/single    form body + hostnode uuid
 *   POST /api/v0/client/delete/single    form body + server uuid
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts
 *     -> auth check + headline (H100/H200/A100/L40S/B200) inventory.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --raw
 *     -> full host inventory including consumer cards.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --gpu h100
 *     -> filter rows by GPU model substring (case-insensitive).
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --servers
 *     -> list account servers via /client/list.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --host <id>
 *     -> dump full host node JSON for one specific host (debug).
 *
 * Env vars:
 *   TENSORDOCK_API_KEY    = Authorization ID (UUID with hyphens)
 *   TENSORDOCK_API_TOKEN  = API Token (alphanumeric; shown once at
 *                           creation, rotate if leaked)
 */

import {
  TensorDockClient,
  isTensorDockConfigured,
  flattenHostNodes,
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
  const gpuIdx = args.indexOf('--gpu')
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : undefined
  const hostIdx = args.indexOf('--host')
  const hostArg = hostIdx >= 0 ? args[hostIdx + 1] : undefined

  const client = new TensorDockClient()

  console.log('Validating credentials via /auth/test ...')
  try {
    const auth = await client.authTest()
    if (!auth.success) {
      console.log(`  -> auth test failed: ${auth.error ?? '(no error message)'}`)
      console.log()
      console.log('Common causes:')
      console.log('  - TENSORDOCK_API_KEY and TENSORDOCK_API_TOKEN swapped')
      console.log('    (KEY = Authorization ID UUID; TOKEN = alphanumeric secret)')
      console.log('  - Authorization revoked or expired')
      console.log('  - Token was leaked and needs to be regenerated')
      process.exit(1)
    }
    console.log(`  -> auth ok.`)
  } catch (err) {
    console.log(`  -> auth test threw: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  console.log()

  if (wantServers) {
    console.log('Account servers (/client/list):')
    const resp = await client.listServers()
    const vms = resp.virtualmachines ?? {}
    const ids = Object.keys(vms)
    if (ids.length === 0) {
      console.log('  (none deployed)')
      return
    }
    for (const id of ids) {
      const s = vms[id]!
      const gpu = `${s.gpu_count ?? '?'}x ${s.gpu_model ?? '?'}`
      console.log(
        `  ${id.padEnd(40)} ${(s.status ?? '?').padEnd(14)} ${gpu.padEnd(36)} ${(s.location ?? '?').padEnd(16)} ${(s.ip ?? '-').padEnd(16)}`,
      )
    }
    return
  }

  console.log('Fetching host inventory via /client/deploy/hostnodes (unauthenticated)...')
  const resp = await client.listHostNodes()
  const hosts = resp.hostnodes ?? {}
  const hostIds = Object.keys(hosts)
  console.log(`  -> ${hostIds.length} hosts in catalog.`)
  console.log()

  if (hostArg) {
    const h = hosts[hostArg]
    if (!h) {
      console.log(`No host with id ${hostArg}`)
      process.exit(1)
    }
    console.log(JSON.stringify(h, null, 2))
    return
  }

  const rows = flattenHostNodes(resp)
  const onlineRows = rows.filter((r) => r.online)
  console.log(`  -> ${rows.length} (host, gpu_model) rows total, ${onlineRows.length} online.`)
  console.log()

  let filtered = onlineRows
  if (gpuArg) {
    filtered = onlineRows.filter((r) => r.gpu_model.toLowerCase().includes(gpuArg.toLowerCase()))
    console.log(`Filtered to ${filtered.length} rows matching --gpu ${gpuArg}:`)
  } else if (wantRaw) {
    console.log(`Full online catalog (${filtered.length} rows):`)
  } else {
    filtered = onlineRows.filter((r) =>
      PRIORITY_TOKENS.some((tok) => r.gpu_model.toLowerCase().includes(tok.toLowerCase())),
    )
    console.log(`Priority datacenter GPUs (${filtered.length} of ${onlineRows.length} online rows):`)
  }
  console.log()

  const sorted = [...filtered].sort((a, b) => {
    if (a.gpu_model !== b.gpu_model) return a.gpu_model.localeCompare(b.gpu_model)
    return b.amount - a.amount
  })

  console.log(
    '  host_id'.padEnd(40)
    + 'country'.padEnd(18)
    + 'gpu_model'.padEnd(28)
    + 'cards'.padStart(6)
    + ' $/h',
  )
  for (const r of sorted) {
    const price = r.price !== undefined ? `$${r.price.toFixed(2)}` : '-'
    console.log(
      `  ${r.hostId.padEnd(38)}  ${r.country.padEnd(16)}  ${r.gpu_model.padEnd(26)}  ${String(r.amount).padStart(4)}  ${price.padStart(6)}`,
    )
  }
  console.log()

  // Aggregate by GPU model across all online hosts.
  const totalsByModel = new Map<string, { cards: number; hosts: number; cheapest?: number }>()
  for (const r of onlineRows) {
    const t = totalsByModel.get(r.gpu_model) ?? { cards: 0, hosts: 0 }
    t.cards += r.amount
    t.hosts += 1
    if (r.price !== undefined) {
      t.cheapest = t.cheapest === undefined ? r.price : Math.min(t.cheapest, r.price)
    }
    totalsByModel.set(r.gpu_model, t)
  }
  const summary = [...totalsByModel.entries()]
    .filter(([m]) =>
      wantRaw || gpuArg
        ? gpuArg ? m.toLowerCase().includes(gpuArg.toLowerCase()) : true
        : PRIORITY_TOKENS.some((tok) => m.toLowerCase().includes(tok.toLowerCase())),
    )
    .sort(([, a], [, b]) => b.cards - a.cards)

  console.log('Totals by GPU model (online hosts only):')
  console.log()
  console.log(
    '  gpu_model'.padEnd(30)
    + 'total_cards'.padStart(12)
    + 'hosts'.padStart(8)
    + 'cheapest_$/h'.padStart(14),
  )
  for (const [model, t] of summary) {
    const cheap = t.cheapest !== undefined ? `$${t.cheapest.toFixed(2)}` : '-'
    console.log(
      `  ${model.padEnd(28)}  ${String(t.cards).padStart(10)}  ${String(t.hosts).padStart(6)}  ${cheap.padStart(12)}`,
    )
  }
  console.log()
  console.log('Re-run with --raw to include consumer cards.')
  console.log('Re-run with --gpu <token> to filter (e.g. --gpu h100, --gpu rtx3090).')
  console.log('Re-run with --servers to list account deployments.')
  console.log('Re-run with --host <host_id> to dump one host raw JSON.')
}

main().catch((err) => {
  console.error(`tensordock-inspect failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
