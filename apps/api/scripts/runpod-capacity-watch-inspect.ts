/**
 * T5e — RunPod capacity watcher inspector.
 *
 * Mirror of lambda-capacity-watch-inspect.ts. Runs ONE tick of the
 * watcher manually so you can verify RUNPOD_CAPACITY_WATCH_IDS is
 * set correctly + see which watched SKUs have stock right now,
 * without waiting 5 min for the cron tick.
 *
 *   pnpm --filter @a2e/api runpod-capacity:inspect
 *     -> show current stock for each watched id + whether an alert
 *        would fire (dedupe state from Redis)
 *
 *   pnpm --filter @a2e/api runpod-capacity:inspect --reset
 *     -> delete all dedupe keys (force a fresh alert on the next tick
 *        for every currently-available watched SKU; useful for forcing
 *        an SMTP delivery test)
 */
import { Redis } from 'ioredis'
import { runRunPodCapacityWatchTick } from '../src/jobs/runpod-capacity-watcher.js'
import { isRunPodConfigured } from '../src/services/inbound/runpod-adapter.js'

async function main(): Promise<void> {
  if (!isRunPodConfigured()) {
    console.log('RUNPOD_API_KEY is not set.')
    process.exit(1)
  }

  const ids = process.env.RUNPOD_CAPACITY_WATCH_IDS?.trim()
  if (!ids) {
    console.log('RUNPOD_CAPACITY_WATCH_IDS is not set.')
    console.log('Add a comma-separated list of RunPod gpu type IDs to Render env, e.g.:')
    console.log('  RUNPOD_CAPACITY_WATCH_IDS=NVIDIA H100 80GB HBM3,NVIDIA H200 NVL,NVIDIA B200')
    console.log('Run runpod:inspect --raw to see every valid id.')
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
    const watched = ids.split(',').map((s) => s.trim()).filter(Boolean)
    let cleared = 0
    for (const id of watched) {
      const removed = await redis.del(`runpod-capacity:notified:${id}`)
      if (removed > 0) cleared++
    }
    console.log(`Cleared ${cleared} dedupe key(s). Next tick will fire fresh alerts for every available watched SKU.`)
    console.log()
  }

  console.log('Running one watcher tick...')
  console.log()
  const result = await runRunPodCapacityWatchTick(redis)

  console.log(`Watched IDs (${result.watchedIds.length}):`)
  for (const id of result.watchedIds) {
    const avail = result.availableNow.find((a) => a.id === id)
    if (avail) {
      const alerted = result.alertedThisTick.includes(id)
      const secure = avail.securePricePerHourUsd !== null ? `$${avail.securePricePerHourUsd.toFixed(2)}/h` : '-'
      const community = avail.communityPricePerHourUsd !== null ? `$${avail.communityPricePerHourUsd.toFixed(2)}/h` : '-'
      console.log(`  ${id}`)
      console.log(`    display:    ${avail.displayName}`)
      console.log(`    secure:     ${secure}`)
      console.log(`    community:  ${community}`)
      console.log(`    alert:      ${alerted ? 'SENT this tick' : 'already alerted within last hour (dedupe held)'}`)
    } else {
      const cleared = result.clearedThisTick.includes(id)
      console.log(`  ${id}`)
      console.log(`    stock:      NONE`)
      if (cleared) console.log(`    note:       dedupe flag cleared (re-armed for next opening)`)
    }
  }

  console.log()
  console.log(`Alerts fired this tick: ${result.alertedThisTick.length}`)
  console.log(`Dedupe keys cleared this tick: ${result.clearedThisTick.length}`)

  if (result.alertedThisTick.length > 0) {
    const recipient = process.env.RUNPOD_CAPACITY_WATCH_EMAIL?.trim() || process.env.LAMBDA_CAPACITY_WATCH_EMAIL?.trim()
    if (!recipient) {
      console.log()
      console.log('NOTE: alert(s) computed but no email recipient is set (RUNPOD_CAPACITY_WATCH_EMAIL or LAMBDA_CAPACITY_WATCH_EMAIL).')
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
