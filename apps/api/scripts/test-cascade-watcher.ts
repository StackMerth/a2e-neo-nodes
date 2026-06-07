/**
 * Cascade capacity watcher manual test.
 *
 * One-shot runner for runCascadeCapacityWatchTick that bypasses the
 * 5-minute BullMQ tick so you can see exactly what the watcher would
 * alert on RIGHT NOW.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/test-cascade-watcher.ts --dry-run
 *     -> flush dedupe, run tick, print what WOULD have alerted, NO email.
 *        Use this first to confirm the matrix returns sane data.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/test-cascade-watcher.ts --send
 *     -> flush dedupe, run tick, SEND the resulting email. Use after
 *        --dry-run looks right.
 *
 *   pnpm --filter @a2e/api exec tsx scripts/test-cascade-watcher.ts
 *     -> run tick WITHOUT flushing dedupe. If you already received an
 *        alert in the last hour for a cell, the cell stays silent.
 *        Useful for "did this tick actually do anything new?"
 *
 * --flush-only flushes Redis dedupe keys and exits. After flushing the
 * next real 5-minute tick re-fires alerts for everything currently
 * available, so this is the "I want the production worker to wake up
 * and send me the current state once" knob.
 *
 * Always exits process when done; spawned for ops, not the server.
 */

import { Redis } from 'ioredis'
import { runCascadeCapacityWatchTick } from '../src/jobs/cascade-capacity-watcher.js'

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const SEND = args.has('--send')
const FLUSH_ONLY = args.has('--flush-only')

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })

  // Flush dedupe keys when caller asked for a clean run. Otherwise
  // the watcher will silently dedupe everything it has alerted on in
  // the last hour and the test looks empty.
  if (DRY_RUN || SEND || FLUSH_ONLY) {
    const pattern = 'cascade-capacity:notified:*'
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
    console.log(`Flushed ${keys.length} cascade dedupe key(s).`)
  }

  if (FLUSH_ONLY) {
    console.log('--flush-only complete. Next 5-min worker tick will re-alert.')
    await redis.quit()
    process.exit(0)
  }

  // Short-circuit the email send when dry-running by unsetting the
  // recipient envs. The watcher will log "no recipient set" instead
  // of sending. The recipient resolver is process-env only, no DB.
  if (DRY_RUN) {
    delete process.env.CAPACITY_WATCH_EMAIL
    delete process.env.LAMBDA_CAPACITY_WATCH_EMAIL
    delete process.env.CASCADE_SNAPSHOT_EMAIL
  }

  console.log(`Running cascade capacity watcher tick (dry-run=${DRY_RUN}, send=${SEND}) ...`)
  const result = await runCascadeCapacityWatchTick(redis)

  console.log(`\nTick complete.`)
  console.log(`  Cells alerted this tick: ${result.alerted.length}`)
  console.log(`  Cells cleared this tick: ${result.cleared.length}`)

  if (result.alerted.length > 0) {
    console.log(`\nAlerted cells (would have emailed):`)
    const grouped = new Map<string, typeof result.alerted>()
    for (const a of result.alerted) {
      const list = grouped.get(a.provider) ?? []
      list.push(a)
      grouped.set(a.provider, list)
    }
    for (const [provider, rows] of grouped.entries()) {
      console.log(`\n  ${provider}:`)
      for (const r of rows.sort((x, y) => x.pricePerHourUsd - y.pricePerHourUsd)) {
        console.log(`    ${r.tier.padEnd(10)} ${String(r.count).padStart(2)}x   $${r.pricePerHourUsd.toFixed(2)}/h`)
      }
    }
  } else {
    console.log(`\nNo cells alerted. Either CASCADE_WATCH_ENABLED=false, or every`)
    console.log(`available cell was already alerted on within the last hour and`)
    console.log(`its dedupe key is still live. Re-run with --dry-run or --send to`)
    console.log(`flush dedupe and see the current state.`)
  }

  if (DRY_RUN) {
    console.log(`\n(dry-run: email recipients were stripped, no email was sent.)`)
  } else if (SEND) {
    console.log(`\nEmail was sent if CAPACITY_WATCH_EMAIL or LAMBDA_CAPACITY_WATCH_EMAIL is set.`)
  }

  await redis.quit()
  process.exit(0)
}

main().catch((err) => {
  console.error('test-cascade-watcher failed:', err)
  process.exit(1)
})
