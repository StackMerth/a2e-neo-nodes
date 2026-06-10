/**
 * E6 / M3.8b: Custom Docker Image Registry — token issuer endpoint.
 *
 * Architecture (full picture so the reader gets the auth flow):
 *
 *   1. Buyer runs `docker login a2e-registry.tokenos.ai -u <buyerId>
 *      -p <a2e-buyer-...>`. Docker CLI stores the basic-auth credential
 *      in ~/.docker/config.json keyed by the registry host.
 *
 *   2. Buyer runs `docker push a2e-registry.tokenos.ai/<buyerId>/myimg:v1`.
 *      Docker CLI hits the registry's GET /v2/ probe.
 *
 *   3. Registry (the `distribution/distribution` open-source binary
 *      deployed as a Render service in M3.8c) is configured with
 *      `auth.token` pointing at THIS endpoint. It responds with:
 *        401 Unauthorized
 *        WWW-Authenticate: Bearer realm="https://a2e-api.onrender.com/v1/registry/token",
 *                                 service="a2e-registry"
 *
 *   4. Docker CLI follows the realm. It GETs THIS endpoint with the
 *      stored basic-auth credentials AND a `scope` query param
 *      describing what it wants to do, e.g.
 *        scope=repository:<buyerId>/myimg:push,pull
 *
 *   5. We validate the API key, ensure the scope is for the buyer's
 *      own namespace (buyerId in the path == buyerId in the basic
 *      auth), and emit a signed JWT in the format the registry
 *      expects (RFC 7519 with the access claims defined in the spec).
 *
 *   6. Docker CLI uses that JWT as a Bearer token on subsequent
 *      registry calls. The registry verifies it locally using the
 *      public key we publish at boot.
 *
 * JWT signing: production uses RS256 with REGISTRY_JWT_PRIVATE_KEY
 * (PEM-encoded RSA private key) set on the API service and the
 * matching public key configured on the registry. Dev fallback uses
 * HS256 with the existing JWT_SECRET so this endpoint works in
 * local + staging without an RSA keypair, but the Docker registry
 * itself requires asymmetric crypto in production so HS256 only
 * round-trips against a mock registry — see M3.8c TODOs.
 *
 * Scope grammar (Docker registry spec):
 *   scope = "repository:" repository ":" actions
 *   actions = action ("," action)*
 *   action = "pull" | "push" | "delete" | "*"
 *
 * Multiple scopes can appear as separate `scope=` query params; we
 * iterate and grant each one only if it passes the namespace check.
 */

import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { verifyApiKey, isBuyerApiKey } from '../services/apikey/manager.js'

const REGISTRY_SERVICE_NAME = process.env.REGISTRY_SERVICE_NAME ?? 'a2e-registry'
const REGISTRY_TOKEN_TTL_SECONDS = 3600
const REGISTRY_ISSUER = process.env.REGISTRY_ISSUER ?? 'a2e-registry-issuer'

interface ScopeRequest {
  type: string         // always "repository" for our use case (could be "registry" for the catalog)
  name: string         // e.g. "cmq1abc/myimg"
  actions: string[]    // ["push", "pull"] etc.
}

interface ResourceAccess {
  type: string
  name: string
  actions: string[]
}

/**
 * Parse a Docker registry scope query string into structured form.
 * `repository:cmq1abc/myimg:push,pull` -> { type: 'repository',
 *   name: 'cmq1abc/myimg', actions: ['push', 'pull'] }
 *
 * Returns null on any parse failure; caller treats null as "deny".
 */
function parseScope(raw: string): ScopeRequest | null {
  const parts = raw.split(':')
  if (parts.length < 3) return null
  const type = parts[0]
  // Repository name may contain colons in the digest case, but for
  // push/pull scopes Docker always uses 3 fields. Use the last token
  // as actions and join the middle ones back as the repository.
  const actionsRaw = parts[parts.length - 1]
  if (!actionsRaw) return null
  const actions = actionsRaw.split(',').filter(Boolean)
  const name = parts.slice(1, -1).join(':')
  if (!type || !name || actions.length === 0) return null
  return { type, name, actions }
}

/**
 * Decide whether to grant each requested action on a given scope for
 * the authenticated user. The rules:
 *
 *   - The repository name MUST start with "<userId>/" so a buyer can
 *     only operate within their own namespace. Cross-namespace access
 *     would let buyer A push over buyer B's image.
 *   - `pull` requires `registry:read` (or any write scope).
 *   - `push`, `delete`, `*` require `registry:write`.
 *
 * Returns the granted actions (subset of requested). If empty, the
 * registry's auth check will fail and the docker CLI gets 401.
 */
function authorizeScope(
  scope: ScopeRequest,
  authedUserId: string,
  apiKeyPermissions: string[],
): string[] {
  // Only "repository" scopes are buyer-namespaced. Other scope types
  // (e.g. "registry:catalog:*") are admin-only and we deny for
  // buyer-issued tokens.
  if (scope.type !== 'repository') return []

  const expectedPrefix = `${authedUserId}/`
  if (!scope.name.startsWith(expectedPrefix)) return []

  const hasRead = apiKeyPermissions.includes('registry:read') ||
                  apiKeyPermissions.includes('registry:write')
  const hasWrite = apiKeyPermissions.includes('registry:write')

  const granted: string[] = []
  for (const action of scope.actions) {
    if (action === 'pull' && hasRead) granted.push(action)
    if ((action === 'push' || action === 'delete' || action === '*') && hasWrite) granted.push(action)
  }
  return granted
}

/**
 * Sign the registry token in the format Docker expects.
 *
 * Required claims per the spec:
 *   - iss: token issuer (must match registry's configured issuer)
 *   - sub: subject — the authenticated user id
 *   - aud: audience — the registry service name
 *   - exp / nbf / iat: standard JWT timestamps
 *   - jti: unique token id (for revocation if we ever add a deny-list)
 *   - access: array of granted scopes
 *
 * Algorithm: RS256 in prod with REGISTRY_JWT_PRIVATE_KEY env. Falls
 * back to HS256 with JWT_SECRET in non-production so dev works
 * without RSA keypair generation. Real Docker registries reject
 * HS256 so the HS256 path is for our own mocks / integration tests
 * only.
 */
function signRegistryToken(
  userId: string,
  access: ResourceAccess[],
): { token: string; expiresIn: number; issuedAt: string } {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: REGISTRY_ISSUER,
    sub: userId,
    aud: REGISTRY_SERVICE_NAME,
    exp: now + REGISTRY_TOKEN_TTL_SECONDS,
    nbf: now - 10, // small skew tolerance
    iat: now,
    jti: `reg-${userId}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    access,
  }

  const rsaPrivateKey = process.env.REGISTRY_JWT_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (rsaPrivateKey) {
    const token = jwt.sign(payload, rsaPrivateKey, { algorithm: 'RS256' })
    return {
      token,
      expiresIn: REGISTRY_TOKEN_TTL_SECONDS,
      issuedAt: new Date(now * 1000).toISOString(),
    }
  }

  // HS256 fallback. Used during the window between M3.8b ship (this
  // endpoint live) and M3.8c (Docker registry container deployed with
  // RSA verification key). The HS256 token is harmless during that
  // window because there is no consumer: no real Docker registry is
  // pointed at this endpoint yet. Once M3.8c lands the registry will
  // be configured to verify RS256-only and reject any HS256 token,
  // so setting REGISTRY_JWT_PRIVATE_KEY becomes a hard requirement
  // by the registry itself rather than something we self-enforce here.
  //
  // In production we log a loud warning every call so the gap is
  // visible in Render logs and the rollout to M3.8c isn't forgotten.
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[registry-token] REGISTRY_JWT_PRIVATE_KEY not set; signing with HS256 dev ' +
        'fallback. This is safe ONLY because no Docker registry currently consumes ' +
        'these tokens. Set REGISTRY_JWT_PRIVATE_KEY (RSA PEM) before deploying the ' +
        'registry container in M3.8c.',
    )
  }

  const devSecret = process.env.JWT_SECRET?.trim() || 'a2e-dev-only-registry-fallback'
  const token = jwt.sign(payload, devSecret, { algorithm: 'HS256' })
  return {
    token,
    expiresIn: REGISTRY_TOKEN_TTL_SECONDS,
    issuedAt: new Date(now * 1000).toISOString(),
  }
}

export async function registryTokenRoutes(fastify: FastifyInstance) {
  /**
   * GET /v1/registry/token?service=&scope=&account=
   *
   * Auth: HTTP Basic via Authorization header.
   *   username = the buyer's User.id (e.g. cmq1abc...)
   *   password = an a2e-buyer-... API key with registry:read or
   *              registry:write permission
   *
   * The Docker CLI sends this when the registry challenges with a
   * Bearer realm. We do NOT mount this behind fastify.authenticate
   * because the basic-auth header isn't a Bearer JWT.
   */
  fastify.get('/v1/registry/token', async (request, reply) => {
    const auth = request.headers.authorization
    if (!auth?.toLowerCase().startsWith('basic ')) {
      return reply.code(401).send({
        errors: [
          { code: 'UNAUTHORIZED', message: 'Basic auth required (Docker login)' },
        ],
      })
    }

    // Decode Basic auth. Docker CLI sends username=account, password=API key.
    let username: string
    let password: string
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
      const idx = decoded.indexOf(':')
      if (idx < 0) throw new Error('malformed basic credentials')
      username = decoded.slice(0, idx)
      password = decoded.slice(idx + 1)
    } catch {
      return reply.code(401).send({
        errors: [{ code: 'DENIED', message: 'Invalid basic auth encoding' }],
      })
    }

    if (!password || !isBuyerApiKey(password)) {
      return reply.code(401).send({
        errors: [
          { code: 'DENIED', message: 'Password must be an a2e-buyer-... API key' },
        ],
      })
    }

    const apiKeyRow = await verifyApiKey(password)
    if (!apiKeyRow) {
      return reply.code(401).send({
        errors: [{ code: 'DENIED', message: 'API key invalid, revoked, or expired' }],
      })
    }

    // The basic-auth username MUST match the API key's owner. Otherwise
    // a leaked key could be used to push under a different buyer's
    // namespace (the username is also what the docker CLI sends as the
    // namespace prefix in `docker push <host>/<username>/<repo>`).
    if (username !== apiKeyRow.userId) {
      return reply.code(401).send({
        errors: [
          { code: 'DENIED', message: 'Basic-auth username must match API key owner' },
        ],
      })
    }

    // Parse the requested scopes. Multiple `scope=` query params are
    // valid per the spec; @fastify/swagger normalises this into an
    // array but in vanilla fastify the second one wins, so we read
    // the raw query and split manually. Empty scope is allowed: it
    // means "just authenticate me, no resource access yet", typical
    // for the initial `docker login` round-trip.
    const query = request.query as Record<string, string | string[] | undefined>
    const rawScopes = query.scope === undefined
      ? []
      : Array.isArray(query.scope) ? query.scope : [query.scope]

    const access: ResourceAccess[] = []
    for (const raw of rawScopes) {
      const parsed = parseScope(raw)
      if (!parsed) continue
      const granted = authorizeScope(parsed, apiKeyRow.userId, apiKeyRow.permissions)
      if (granted.length > 0) {
        access.push({ type: parsed.type, name: parsed.name, actions: granted })
      }
    }

    const { token, expiresIn, issuedAt } = signRegistryToken(apiKeyRow.userId, access)
    reply.send({
      token,
      access_token: token, // alias kept by older Docker CLIs (<1.11)
      expires_in: expiresIn,
      issued_at: issuedAt,
    })
  })
}
