/**
 * TensorDock account balance check.
 *
 * Per the ryan-huang1/tensordock-python-sdk source, /billing/balance
 * returns { balance, hourly_cost, success }. If the account balance is
 * zero or below the cost of a deploy, TensorDock's /client/deploy/single
 * 500s with a generic Flask error page instead of a structured
 * "insufficient balance" response. The deploy-test has hit this exact
 * pattern (3.3s consistent fail across every payload variant), which
 * is the smoking gun for an unfunded account.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/tensordock-balance.ts
 */

const SCRIPT_VERSION = '2026-06-08-balance-check'

async function main(): Promise<void> {
  console.log(`tensordock-balance v${SCRIPT_VERSION}`)
  console.log()

  const apiKey = (process.env.TENSORDOCK_API_KEY ?? '').trim()
  const apiToken = (process.env.TENSORDOCK_API_TOKEN ?? '').trim()
  if (!apiKey || !apiToken) {
    console.log('TENSORDOCK_API_KEY and TENSORDOCK_API_TOKEN must be set.')
    process.exit(1)
  }

  const baseUrl = (process.env.TENSORDOCK_API_BASE ?? 'https://marketplace.tensordock.com/api/v0').replace(/\/+$/, '')

  console.log(`Calling ${baseUrl}/billing/balance ...`)
  const body = new URLSearchParams({ api_key: apiKey, api_token: apiToken }).toString()
  const res = await fetch(`${baseUrl}/billing/balance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'a2e-engine-tensordock/1.0',
      'Accept': 'application/json',
    },
    body,
  })
  const text = await res.text()
  console.log(`HTTP ${res.status} ${res.ok ? 'OK' : 'FAIL'}`)
  console.log()
  console.log('--- RESPONSE BODY ---')
  console.log(text)
  console.log('---------------------')
  console.log()

  if (!res.ok) {
    console.log('Balance check failed. If auth is the problem, /auth/test would have failed too.')
    process.exit(1)
  }

  let parsed: { balance?: number; hourly_cost?: number; success?: boolean }
  try {
    parsed = JSON.parse(text)
  } catch {
    console.log('Response is not JSON. Cannot interpret balance.')
    process.exit(1)
  }

  const balance = typeof parsed.balance === 'number' ? parsed.balance : null
  const hourlyCost = typeof parsed.hourly_cost === 'number' ? parsed.hourly_cost : null

  console.log(`Account balance:  $${balance !== null ? balance.toFixed(2) : '(unknown)'}`)
  console.log(`Hourly burn rate: $${hourlyCost !== null ? hourlyCost.toFixed(4) : '(unknown)'}`)
  console.log()

  if (balance === null) {
    console.log('Could not parse balance from response. Inspect the body above.')
    return
  }

  if (balance <= 0.01) {
    console.log('--------------------------------------------------------------')
    console.log('ACCOUNT IS UNFUNDED. This is the cause of every deploy 500.')
    console.log('--------------------------------------------------------------')
    console.log('TensorDock returns generic 500 from /client/deploy/single when')
    console.log('the account has insufficient balance to cover the deploy. Add')
    console.log('funds via the dashboard:')
    console.log('  https://dashboard.tensordock.com/billing')
    console.log()
    console.log('Minimum deposit is usually $10. For a $0.07/h test rental run')
    console.log('for 30 seconds, $0.001 is consumed; even a $1 deposit lets us')
    console.log('verify the cascade end-to-end. Recommended: $5-10 to cover')
    console.log('multiple test runs + future cascade rentals.')
    process.exit(2)
  }

  if (balance < 1.0) {
    console.log(`Balance is positive but low ($${balance.toFixed(2)}). If TensorDock requires`)
    console.log('a minimum reserve (some providers hold $1-5 above the rental cost),')
    console.log('the deploy may still 500. Recommend topping up to >= $5.')
    return
  }

  console.log('Balance is sufficient. The deploy 500 has another cause.')
  console.log('Continue debugging via tensordock-deploy-test.ts.')
}

main().catch((err) => {
  console.error('tensordock-balance failed:', err)
  process.exit(1)
})
