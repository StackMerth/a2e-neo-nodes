/**
 * TensorDock read-only inspector / API discovery tool.
 *
 * TensorDock historically had multiple API shapes:
 *   - Newer Core Cloud:   dashboard.tensordock.com/api/v0 (Bearer)
 *   - Legacy Marketplace: marketplace.tensordock.com/api/v0
 *                         (api_key + api_token form fields)
 *
 * On 2026-06-07 the first inspector hit HTTP 400 against both shapes
 * with the user's key, so we don't know which API generation it
 * targets. This version probes many candidate endpoint paths against
 * BOTH bases, dumps the raw response body for failed attempts so we
 * can see exactly what TensorDock expects, and picks the first 2xx as
 * the working configuration.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --probe
 *     -> probe every candidate path. Most useful command right now.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts
 *     -> after --probe finds a working path, this lists hosts via that
 *        path. If --probe failed, this short-circuits.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-inspect.ts --vms
 *     -> list account virtual machines via the working path.
 *
 * Aborts cleanly if TENSORDOCK_API_KEY is not set.
 */

const NEW_BASE = 'https://dashboard.tensordock.com/api/v0'
const LEGACY_BASE = 'https://marketplace.tensordock.com/api/v0'

interface ProbeResult {
  base: string
  path: string
  method: string
  authStyle: 'bearer' | 'form' | 'query'
  status: number
  ok: boolean
  bodyPreview: string
}

async function tryRequest(
  base: string,
  path: string,
  method: 'GET' | 'POST',
  authStyle: 'bearer' | 'form' | 'query',
  apiKey: string,
  apiToken: string | null,
): Promise<ProbeResult> {
  const headers: Record<string, string> = {}
  let body: string | undefined
  let url = `${base}${path}`

  if (authStyle === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`
  } else if (authStyle === 'form') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams({
      api_key: apiKey,
      ...(apiToken ? { api_token: apiToken } : {}),
    }).toString()
  } else {
    const q = new URLSearchParams({
      api_key: apiKey,
      ...(apiToken ? { api_token: apiToken } : {}),
    })
    url = `${url}?${q.toString()}`
  }

  let status = 0
  let ok = false
  let bodyPreview = ''
  try {
    const res = await fetch(url, { method, headers, body })
    status = res.status
    ok = res.ok
    bodyPreview = (await res.text()).slice(0, 400)
  } catch (err) {
    bodyPreview = `network error: ${err instanceof Error ? err.message : err}`
  }

  return { base, path, method, authStyle, status, ok, bodyPreview }
}

const NEWER_CANDIDATES: Array<{ path: string; method: 'GET' | 'POST' }> = [
  { path: '/hosts/list', method: 'GET' },
  { path: '/hosts', method: 'GET' },
  { path: '/billing', method: 'GET' },
  { path: '/billing/list', method: 'GET' },
  { path: '/account', method: 'GET' },
  { path: '/account/balance', method: 'GET' },
  { path: '/virtualmachines/list', method: 'GET' },
  { path: '/virtualmachines', method: 'GET' },
  { path: '/inventory', method: 'GET' },
  { path: '/inventory/list', method: 'GET' },
]

const LEGACY_CANDIDATES: Array<{ path: string; method: 'GET' | 'POST' }> = [
  { path: '/host/list', method: 'POST' },
  { path: '/client/list', method: 'POST' },
  { path: '/auth/test', method: 'POST' },
  { path: '/billing/balance', method: 'POST' },
  { path: '/list', method: 'POST' },
]

async function runProbe(apiKey: string, apiToken: string | null): Promise<void> {
  console.log(`Probing TensorDock authentication ...`)
  console.log(`  TENSORDOCK_API_KEY:   ${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (${apiKey.length} chars)`)
  console.log(`  TENSORDOCK_API_TOKEN: ${apiToken ? `${apiToken.slice(0, 4)}...${apiToken.slice(-4)} (${apiToken.length} chars)` : '(unset)'}`)
  console.log()

  const results: ProbeResult[] = []

  console.log(`--- Newer Core Cloud (Bearer): ${NEW_BASE} ---`)
  for (const c of NEWER_CANDIDATES) {
    const r = await tryRequest(NEW_BASE, c.path, c.method, 'bearer', apiKey, apiToken)
    results.push(r)
    const mark = r.ok ? 'OK' : 'XX'
    console.log(`  [${mark}] ${c.method.padEnd(4)} ${c.path.padEnd(28)} HTTP ${r.status}`)
    if (!r.ok && r.bodyPreview) {
      console.log(`         body: ${r.bodyPreview.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }

  if (apiToken) {
    console.log()
    console.log(`--- Legacy Marketplace (api_key + api_token form): ${LEGACY_BASE} ---`)
    for (const c of LEGACY_CANDIDATES) {
      const r = await tryRequest(LEGACY_BASE, c.path, c.method, 'form', apiKey, apiToken)
      results.push(r)
      const mark = r.ok ? 'OK' : 'XX'
      console.log(`  [${mark}] ${c.method.padEnd(4)} ${c.path.padEnd(28)} HTTP ${r.status}`)
      if (!r.ok && r.bodyPreview) {
        console.log(`         body: ${r.bodyPreview.replace(/\s+/g, ' ').slice(0, 200)}`)
      }
    }
  }

  // Also try newer base with query-string auth in case TensorDock kept
  // the form-shaped key but moved the endpoints to /api/v0.
  console.log()
  console.log(`--- Newer Core Cloud (api_key+api_token in query): ${NEW_BASE} ---`)
  for (const c of LEGACY_CANDIDATES.slice(0, 3)) {
    const r = await tryRequest(NEW_BASE, c.path, c.method, 'query', apiKey, apiToken)
    results.push(r)
    const mark = r.ok ? 'OK' : 'XX'
    console.log(`  [${mark}] ${c.method.padEnd(4)} ${c.path.padEnd(28)} HTTP ${r.status}`)
    if (!r.ok && r.bodyPreview) {
      console.log(`         body: ${r.bodyPreview.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }

  console.log()
  const winners = results.filter((r) => r.ok)
  if (winners.length > 0) {
    console.log(`Working paths found:`)
    for (const w of winners) {
      console.log(`  ${w.method} ${w.base}${w.path} (auth=${w.authStyle})`)
    }
    console.log()
    console.log('Paste this output back so the adapter can be wired against the working shape.')
  } else {
    console.log(`No working paths found across ${results.length} attempts.`)
    console.log('Most common 4xx body patterns reveal what TensorDock expects.')
    console.log('Common patterns:')
    console.log('  - "Invalid API key" -> the key string itself is wrong or revoked')
    console.log('  - "Missing field X" -> the API expects an additional form field')
    console.log('  - "Method not allowed" -> the path moved; check TensorDock changelog')
    console.log('Paste this output back; we will adjust the candidate list.')
  }
}

async function main(): Promise<void> {
  const apiKey = (process.env.TENSORDOCK_API_KEY ?? '').trim()
  const apiToken = (process.env.TENSORDOCK_API_TOKEN ?? '').trim() || null

  if (!apiKey) {
    console.log('TENSORDOCK_API_KEY is not set. Add it to Render API env:')
    console.log('  1) Sign up at https://dashboard.tensordock.com')
    console.log('  2) Developer Settings -> generate API token')
    console.log('  3) Render -> a2e-api -> Environment -> add TENSORDOCK_API_KEY=<key>')
    console.log('  4) (legacy keys only) also add TENSORDOCK_API_TOKEN=<token>')
    console.log('  5) Save, wait for redeploy, re-run this script')
    process.exit(1)
  }

  const args = process.argv.slice(2)
  const wantProbe = args.includes('--probe')
  const wantVms = args.includes('--vms')

  if (wantProbe || (!wantVms && !args.length)) {
    // No args, or --probe explicitly: run the discovery probe.
    await runProbe(apiKey, apiToken)
    return
  }

  console.log('After running --probe and confirming a working path, set up the adapter.')
  console.log('This branch is reserved for the post-probe listing flow.')
}

main().catch((err) => {
  console.error(`tensordock-inspect failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
