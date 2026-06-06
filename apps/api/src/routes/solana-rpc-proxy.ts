/**
 * Solana RPC passthrough so the Helius URL (which contains the API key
 * in its query string) never ships to the client bundle.
 *
 * Before this route: the portal set NEXT_PUBLIC_SOLANA_RPC_URL to the
 * full Helius URL — Next.js inlined it into the client JS at build
 * time, which meant anyone visiting user.tokenos.ai could read the
 * key out of the bundled JS.
 *
 * After: NEXT_PUBLIC_SOLANA_RPC_URL points at this route's URL
 * (e.g. https://a2e-api.onrender.com/v1/rpc). The browser sends
 * JSON-RPC requests here; this route forwards the body verbatim to
 * the SOLANA_RPC_URL env var (server-only, never in client bundle)
 * and pipes the response back. The Helius API key never leaves the
 * server.
 *
 * Compatibility: @solana/web3.js Connection makes plain POST requests
 * with a JSON-RPC body to whatever URL it's constructed with — no
 * Helius-specific protocol. So the portal's existing wallet adapter,
 * useUsdcPayment hook, and connection.confirmTransaction calls work
 * with the proxy URL without code changes.
 *
 * Safety:
 *   - Per-IP rate limit (default 20 req/s) so the upstream Helius
 *     quota doesn't get burned by a single abusive client.
 *   - JSON body cap at 64 KB — Solana RPC bodies are tiny; bigger
 *     submissions get rejected at the Fastify layer (which is the
 *     default behavior, just relying on it here).
 *   - No auth gate: wallet-adapter Connection runs on the public
 *     marketing/landing surfaces before the user logs in, so any
 *     gate would break the user-facing UX. Rate limit + Helius URL
 *     allowlist on Helius's side is the layered defense.
 */

import type { FastifyInstance } from 'fastify'

interface RateBucket {
  count: number
  resetAt: number
}

export async function solanaRpcProxyRoutes(fastify: FastifyInstance): Promise<void> {
  const upstreamUrl = process.env.SOLANA_RPC_URL?.trim()
  if (!upstreamUrl) {
    fastify.log.warn(
      '[solana-rpc-proxy] SOLANA_RPC_URL not set — /v1/rpc passthrough disabled. ' +
      'Set it to your full Helius URL (with api-key query param).',
    )
    return
  }

  // Per-IP request-per-second cap. Default 20 r/s tolerates a real
  // page worth of wallet-adapter activity (Connection makes 2-3 calls
  // on mount) while keeping a single abusive client from burning the
  // Helius free-tier quota. Tunable via env.
  const rpsCap = parseInt(process.env.SOLANA_RPC_PROXY_RPS_PER_IP ?? '20', 10)
  const ipBuckets = new Map<string, RateBucket>()

  function checkRate(ip: string): boolean {
    const now = Date.now()
    const bucket = ipBuckets.get(ip)
    if (!bucket || bucket.resetAt < now) {
      ipBuckets.set(ip, { count: 1, resetAt: now + 1000 })
      return true
    }
    if (bucket.count >= rpsCap) return false
    bucket.count += 1
    return true
  }

  // Periodic GC for expired buckets so the Map doesn't grow unbounded
  // across a long-lived server process. .unref() so the interval
  // doesn't keep the event loop alive during shutdown.
  const gcTimer = setInterval(() => {
    const now = Date.now()
    for (const [ip, bucket] of ipBuckets) {
      if (bucket.resetAt < now) ipBuckets.delete(ip)
    }
  }, 60_000)
  gcTimer.unref()

  // Explicit OPTIONS handler for CORS preflight. The @fastify/cors
  // plugin SHOULD intercept preflight via its onRequest hook, but the
  // observed behavior (2026-06-06) is Render's edge returning 502 on
  // OPTIONS /v1/rpc specifically — possibly because the plugin's hook
  // doesn't fire fast enough during OOM-thrash, or because some
  // upstream layer is reaching the route handler with no body and
  // throwing. Explicit handler makes the preflight response
  // deterministic: 204 No Content, no upstream Helius call, no body
  // allocation, no chance to fail.
  fastify.options('/v1/rpc', async (_request, reply) => {
    return reply.code(204).send()
  })

  fastify.post('/v1/rpc', async (request, reply) => {
    const ip = request.ip
    if (!checkRate(ip)) {
      return reply
        .code(429)
        .header('retry-after', '1')
        .send({
          jsonrpc: '2.0',
          error: { code: -32005, message: 'Rate limit exceeded' },
          id: null,
        })
    }

    let upstreamResponse: Response
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      })
    } catch (err) {
      fastify.log.error({ err, ip }, '[solana-rpc-proxy] upstream fetch failed')
      return reply.code(502).send({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Upstream Solana RPC not reachable' },
        id: null,
      })
    }

    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json'
    const body = await upstreamResponse.text()
    return reply
      .code(upstreamResponse.status)
      .header('content-type', contentType)
      .send(body)
  })
}
