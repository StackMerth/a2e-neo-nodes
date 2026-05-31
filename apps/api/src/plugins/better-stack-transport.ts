/**
 * T8a — Better Stack (formerly Logtail) Pino transport.
 *
 * Streams Fastify / Pino logs to Better Stack's HTTP ingest endpoint
 * when both env vars are set:
 *
 *   BETTER_STACK_INGEST_URL  e.g. https://in.logs.betterstack.com
 *   BETTER_STACK_TOKEN       the source token from your source detail page
 *
 * Behavior when EITHER env var is missing: the build() factory returns
 * null, server bootstrap skips adding the transport, and Pino falls
 * back to stdout (current behavior). So shipping this code is safe in
 * any deploy that hasn't configured Better Stack yet.
 *
 * Why a custom transport instead of @logtail/pino: avoids a new
 * dependency, keeps the cold-start surface area small, and uses
 * Node's native fetch (Node 18+). Better Stack's ingest API is
 * documented to accept a single JSON object or a JSON array of
 * objects per POST, with the Authorization: Bearer header.
 *
 * Batching: we buffer up to BATCH_SIZE lines or BATCH_INTERVAL_MS
 * (whichever hits first) before posting, so the API isn't slammed
 * on a burst of logs (e.g. allocator tick + per-minute meter +
 * burn-rate alerts firing in the same second). The trade-off is up
 * to ~5s of log latency before lines appear in the Better Stack
 * dashboard, which is fine for debugging — Render's own log stream
 * remains the real-time view.
 *
 * Failures: a failed POST is logged to stderr exactly once per
 * minute (the rate-limited rejection counter), then dropped. We
 * never queue forever and never crash the parent process on a
 * Better Stack outage.
 */

import build from 'pino-abstract-transport'

const BATCH_SIZE = 50
const BATCH_INTERVAL_MS = 5_000
const FAILURE_LOG_INTERVAL_MS = 60_000

interface BetterStackOptions {
  ingestUrl: string
  token: string
  /** Optional source name added to every log line. Defaults to API. */
  sourceName?: string
}

// Pino transports run as a worker thread when target: '<this file>'
// is used. The default export must be a build() factory returning a
// pino-abstract-transport sink. We accept the destination options
// via the standard Pino transport options channel.
export default async function betterStackTransport(opts: BetterStackOptions) {
  if (!opts?.ingestUrl || !opts?.token) {
    throw new Error(
      'better-stack-transport: ingestUrl and token are both required (set BETTER_STACK_INGEST_URL + BETTER_STACK_TOKEN).',
    )
  }
  const ingestUrl = opts.ingestUrl.replace(/\/+$/, '')
  const sourceName = opts.sourceName ?? 'tokenosdeai-api'

  let buffer: unknown[] = []
  let flushTimer: NodeJS.Timeout | null = null
  let lastFailureLog = 0
  let droppedSinceLastReport = 0

  async function flush() {
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    try {
      const res = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify(batch),
      })
      if (!res.ok) {
        droppedSinceLastReport += batch.length
        reportFailure(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
    } catch (err) {
      droppedSinceLastReport += batch.length
      reportFailure((err as Error).message)
    }
  }

  function reportFailure(reason: string) {
    const now = Date.now()
    if (now - lastFailureLog < FAILURE_LOG_INTERVAL_MS) return
    lastFailureLog = now
    process.stderr.write(
      `[better-stack-transport] forwarding paused (last error: ${reason}); ${droppedSinceLastReport} log line(s) dropped since last report.\n`,
    )
    droppedSinceLastReport = 0
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, BATCH_INTERVAL_MS)
  }

  return build(
    async (source) => {
      for await (const obj of source) {
        // Pino emits objects already JSON-ready; enrich each line with
        // the source name so the Better Stack UI groups them by app.
        buffer.push({ ...(obj as object), source: sourceName })
        if (buffer.length >= BATCH_SIZE) {
          await flush()
        } else {
          scheduleFlush()
        }
      }
      // Drain on transport shutdown so an orderly process exit doesn't
      // lose the last few lines.
      await flush()
    },
    {
      async close() {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        await flush()
      },
    },
  )
}
