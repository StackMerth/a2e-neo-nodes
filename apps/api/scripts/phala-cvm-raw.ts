/**
 * Diagnostic: dump the raw JSON response from Phala's CVM endpoints
 * (GET /api/v1/cvms and GET /api/v1/cvms/{id}) without our normalizer.
 *
 * Why: phala-provision:test --poll returned provider status='stopped'
 * for a freshly-provisioned CVM. We need to see Phala's actual field
 * shape + status vocabulary to know whether:
 *   - status strings are lowercase (mapPhalaStatus is case-sensitive)
 *   - dstack CVMs need an explicit /cvms/{id}/start call after create
 *   - there are other lifecycle fields we're ignoring (billing_state,
 *     is_running, started_at, etc.)
 *
 *   pnpm --filter @a2e/api phala:cvm-raw
 *     -> dumps GET /cvms (list) full raw
 *
 *   pnpm --filter @a2e/api phala:cvm-raw <cvmId>
 *     -> dumps GET /cvms/<id> full raw
 *
 * Read-only. No state mutation.
 */

async function main(): Promise<void> {
  const apiKey = process.env.PHALA_API_KEY?.trim()
  if (!apiKey) {
    console.error('PHALA_API_KEY not set in environment.')
    process.exit(1)
  }

  const base =
    process.env.PHALA_API_BASE?.trim() || 'https://cloud-api.phala.com/api/v1'
  const id = process.argv[2]
  const url = id
    ? `${base.replace(/\/+$/, '')}/cvms/${encodeURIComponent(id)}`
    : `${base.replace(/\/+$/, '')}/cvms`

  console.log(`GET ${url}`)
  console.log()

  const res = await fetch(url, {
    headers: { 'X-API-Key': apiKey },
  })

  const text = await res.text()
  console.log(`HTTP ${res.status} ${res.statusText}`)
  console.log()

  try {
    const json = JSON.parse(text)
    console.log(JSON.stringify(json, null, 2))
  } catch {
    console.log('(non-JSON body):')
    console.log(text)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
