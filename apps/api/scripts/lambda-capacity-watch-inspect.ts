/**
 * T5d — Lambda capacity watcher inspector.
 *
 * Runs ONE tick of the watcher manually and prints what would be
 * alerted on. Useful for:
 *
 *   - Verifying LAMBDA_CAPACITY_WATCH_SKUS is set correctly after a
 *     Render env change (without waiting 5 min for the next tick)
 *   - Forcing an alert email NOW for a SKU that already has capacity,
 *     to confirm SMTP delivery works
 *   - Inspecting which watched SKUs have capacity right now without
 *     touching the alert state
 *
 *   pnpm --filter @a2e/api lambda-capacity:inspect
 *     -> show current capacity for each watched SKU + whether an alert
 *        would fire (dedupe state from Redis)
 *
 *   pnpm --filter @a2e/api lambda-capacity:inspect --reset
 *     -> delete all dedupe keys (so the NEXT tick fires fresh alerts
 *        for every currently-available watched SKU; useful for forcing
 *        an SMTP delivery test)
 *
 * Aborts cleanly if LAMBDA_API_KEY or LAMBDA_CAPACITY_WATCH_SKUS is
 * missing.
 */
import { Redis } from 'ioredis'
import { runCapacityWatchTick } from '../src/jobs/lambda-capacity-watcher.js'
import { isLambdaConfigured } from '../src/services/inbound/lambda-adapter.js'

async function main(): Promise<void> {
  if (!isLambdaConfigured()) {
    console.log('LAMBDA_API_KEY is not set. Add it to Render env first.')
    process.exit(1)
  }

  const skus = process.env.LAMBDA_CAPACITY_WATCH_SKUS?.trim()
  if (!skus) {
    console.log('LAMBDA_CAPACITY_WATCH_SKUS is not set.')
    console.log('Add a comma-separated list of Lambda SKU names to Render env, e.g.:')
    console.log('  LAMBDA_CAPACITY_WATCH_SKUS=gpu_8x_h100_sxm5,gpu_4x_b200_sxm6')
    console.log('Run lambda:inspect --raw to see every valid SKU name.')
    process.exit(1)
  }

  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    console.log('REDIS_URL is not set (the watcher uses Redis for alert dedupe).')
    process.exit(1)
  }
  const redis = new Redis(redisUrl)

  const wantReset = process.argv.includes('--reset')
  if (wantReset) {
    const watched = skus.split(',').map((s) => s.trim()).filter(Boolean)
    let cleared = 0
    for (const sku of watched) {
      const removed = await redis.del(`lambda-capacity:notified:${sku}`)
      if (removed > 0) cleared++
    }
    console.log(`Cleared ${cleared} dedupe key(s). Next tick will fire fresh alerts for every available watched SKU.`)
    console.log()
  }

  console.log('Running one watcher tick...')
  console.log()
  const result = await runCapacityWatchTick(redis)

  console.log(`Watched SKUs (${result.watchedSkus.length}):`)
  for (const sku of result.watchedSkus) {
    const avail = result.availableNow.find((a) => a.name === sku)
    if (avail) {
      const alerted = result.alertedThisTick.includes(sku)
      console.log(`  ${sku}`)
      console.log(`    price:    $${avail.pricePerHourUsd.toFixed(2)}/h`)
      console.log(`    regions:  ${avail.regionsAvailable.join(', ')}`)
      console.log(`    alert:    ${alerted ? 'SENT this tick' : 'already alerted within last hour (dedupe held)'}`)
    } else {
      const cleared = result.clearedThisTick.includes(sku)
      console.log(`  ${sku}`)
      console.log(`    capacity: NONE`)
      if (cleared) {
        console.log(`    note:     dedupe flag cleared (re-armed for next opening)`)
      }
    }
  }

  console.log()
  console.log(`Alerts fired this tick: ${result.alertedThisTick.length}`)
  console.log(`Dedupe keys cleared this tick: ${result.clearedThisTick.length}`)

  if (result.alertedThisTick.length > 0) {
    const recipient = process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim()
    if (!recipient) {
      console.log()
      console.log('NOTE: alert(s) computed but LAMBDA_CAPACITY_WATCH_EMAIL is unset, so no email was sent.')
    } else {
      console.log()
      console.log(`Alert email sent to ${recipient}.`)
    }
  }

  await redis.quit()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
