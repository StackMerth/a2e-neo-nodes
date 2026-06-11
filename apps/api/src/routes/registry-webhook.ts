/**
 * E6 / M3.9a: Custom Docker Image Registry — webhook receiver.
 *
 * The registry POSTs to /v1/registry/webhook on every interesting
 * event (push/pull/delete). We consume the `push` events to:
 *
 *   1. Upsert a DockerImage row keyed on (userId, repository, tag).
 *      A re-push of the same tag replaces the prior row in-place,
 *      which is what buyers expect (the tag now points at a new
 *      digest, so older scans no longer apply).
 *   2. Enqueue an ImageScan job so a Trivy worker can pull the new
 *      image and check it for critical CVEs. The scan is created in
 *      PENDING status synchronously; the worker (M3.9b) transitions
 *      it to RUNNING → COMPLETED/FAILED.
 *
 * Auth: the registry sends `Authorization: Bearer <REGISTRY_WEBHOOK_SECRET>`
 * on every call (configured on the registry service via the env var
 * REGISTRY_NOTIFICATIONS_ENDPOINTS_0_HEADERS_AUTHORIZATION_0). We compare
 * the incoming header to the same secret. Without this check, anyone
 * who knew the URL could POST forged push events and pollute the
 * DockerImage table.
 *
 * Event payload shape (distribution v2.8.3):
 *   {
 *     "events": [{
 *       "id": "uuid",
 *       "timestamp": "2026-06-10T...",
 *       "action": "push" | "pull" | "delete",
 *       "target": {
 *         "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
 *         "size": 1234,
 *         "digest": "sha256:abc...",
 *         "length": 1234,
 *         "repository": "<userId>/<reponame>",
 *         "url": "https://a2e-registry.onrender.com/v2/<userId>/<reponame>/manifests/sha256:abc...",
 *         "tag": "v1"
 *       },
 *       "request": { "id": ..., "addr": ..., "host": ..., "method": ..., "useragent": ... },
 *       "actor": { "name": "<userId>" },
 *       "source": { "addr": ..., "instanceID": "..." }
 *     }, ...]
 *   }
 *
 * The events array can contain MULTIPLE events per call — for a single
 * docker push the registry sends one event per layer plus one for the
 * final manifest. We only act on the manifest event (mediaType ends in
 * `+json`) so we don't create N+1 DockerImage rows per push.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Queue } from 'bullmq'
import { getQuotaSnapshot } from '../services/registry/quota.js'

interface RegistryEvent {
  id?: string
  timestamp?: string
  action?: string
  target?: {
    mediaType?: string
    size?: number
    digest?: string
    length?: number
    repository?: string
    url?: string
    tag?: string
  }
  actor?: { name?: string }
  request?: Record<string, unknown>
  source?: Record<string, unknown>
}

interface RegistryWebhookPayload {
  events?: RegistryEvent[]
}

/**
 * Tag a media type as a manifest type (the "this is the final push
 * event for this image" signal). Distribution publishes one event per
 * blob (layer) PLUS one for the manifest; only the manifest one carries
 * the (repo, tag) pair we want to persist.
 *
 * Known manifest media types as of 2026-06:
 *   - application/vnd.docker.distribution.manifest.v2+json (v2 single-arch)
 *   - application/vnd.docker.distribution.manifest.list.v2+json (v2 multi-arch list)
 *   - application/vnd.oci.image.manifest.v1+json (OCI v1 single-arch)
 *   - application/vnd.oci.image.index.v1+json (OCI v1 multi-arch list)
 *
 * Any media type ending in `manifest.v*+json` or `manifest.list.v*+json`
 * or `image.manifest.v*+json` or `image.index.v*+json` is a manifest.
 * Layer/blob events end in `+gzip`, `+tar`, or include `layer.`.
 */
function isManifestMediaType(mediaType?: string): boolean {
  if (!mediaType) return false
  if (mediaType.includes('layer')) return false
  return mediaType.endsWith('+json') &&
    (mediaType.includes('manifest') || mediaType.includes('index'))
}

/**
 * Parse a "<userId>/<repository>" string into its parts.
 * Returns null if the format doesn't match — defensive guard against
 * malformed events; we should never see these because the registry's
 * own auth (our token issuer) rejects pushes that don't follow the
 * <userId>/... namespace, but verify-then-trust beats trust-then-act.
 */
function splitNamespacedRepo(full?: string): { userId: string; repo: string } | null {
  if (!full) return null
  const idx = full.indexOf('/')
  if (idx <= 0 || idx === full.length - 1) return null
  const userId = full.slice(0, idx)
  const repo = full.slice(idx + 1)
  if (!userId || !repo) return null
  return { userId, repo }
}

interface WebhookRouteDeps {
  imageScanQueue: Queue
}

export async function registryWebhookRoutes(
  fastify: FastifyInstance,
  deps: WebhookRouteDeps,
) {
  fastify.post(
    '/v1/registry/webhook',
    async (request: FastifyRequest, reply) => {
      // 1. Verify the shared secret. Constant-time string compare is
      // overkill for a non-customer-facing internal endpoint, but we
      // still want to reject early on bad auth so the rest of the
      // pipeline doesn't waste cycles parsing forged payloads.
      const expected = process.env.REGISTRY_WEBHOOK_SECRET
      if (!expected) {
        // Misconfiguration on our side — fail loud so it gets noticed.
        request.log.error(
          'REGISTRY_WEBHOOK_SECRET not set; rejecting all webhook calls',
        )
        return reply.code(503).send({ error: 'webhook receiver not configured' })
      }
      const authHeader = request.headers.authorization
      if (authHeader !== `Bearer ${expected}`) {
        request.log.warn(
          { ip: request.ip, ua: request.headers['user-agent'] },
          'registry webhook auth failed',
        )
        return reply.code(401).send({ error: 'unauthorized' })
      }

      // 2. Parse + dispatch. Distribution batches events; we iterate.
      const payload = request.body as RegistryWebhookPayload | undefined
      if (!payload?.events || !Array.isArray(payload.events)) {
        return reply.code(400).send({ error: 'missing events array' })
      }

      let processed = 0
      let skipped = 0

      for (const event of payload.events) {
        // Only act on push of manifest media types. Layer pushes are
        // ignored (they're noise; the manifest event tells us the
        // image as a whole is durable).
        if (event.action !== 'push') {
          skipped++
          continue
        }
        if (!isManifestMediaType(event.target?.mediaType)) {
          skipped++
          continue
        }

        // Repository must be namespaced under <userId>/...
        const split = splitNamespacedRepo(event.target?.repository)
        if (!split) {
          request.log.warn(
            { repo: event.target?.repository },
            'registry webhook saw non-namespaced repository, skipping',
          )
          skipped++
          continue
        }

        // Verify the userId from the repo namespace matches an existing
        // user. Without this, a misbehaving registry (or a successful
        // namespace-bypass elsewhere) could create DockerImage rows
        // owned by phantom users.
        const user = await fastify.prisma.user.findUnique({
          where: { id: split.userId },
          select: { id: true },
        })
        if (!user) {
          request.log.warn(
            { userId: split.userId, repo: split.repo },
            'registry webhook references unknown userId, skipping',
          )
          skipped++
          continue
        }

        const tag = event.target?.tag ?? 'latest'
        const digest = event.target?.digest ?? ''
        const sizeBytes = BigInt(event.target?.length ?? event.target?.size ?? 0)

        // Upsert. (userId, repository, tag) is the unique key — a
        // re-push of the same tag replaces the prior row's digest +
        // size + pushedAt. Prior scans cascade-delete via FK because
        // ImageScan.imageId references DockerImage.id and we're not
        // changing the id; we ARE clearing pullBlocked because the
        // new digest may have fixed CVEs that flagged the old one.
        const image = await fastify.prisma.dockerImage.upsert({
          where: {
            userId_repository_tag: {
              userId: split.userId,
              repository: split.repo,
              tag,
            },
          },
          create: {
            userId: split.userId,
            repository: split.repo,
            tag,
            digest,
            sizeBytes,
          },
          update: {
            digest,
            sizeBytes,
            pushedAt: new Date(),
            deletedAt: null,
            pullBlocked: false,
            pullBlockReason: null,
          },
        })

        // Enqueue a scan. PENDING status is the default; the worker
        // will transition through RUNNING → COMPLETED/FAILED. We
        // create the row synchronously so the scan history is
        // visible immediately in the buyer UI even before Trivy runs.
        const scan = await fastify.prisma.imageScan.create({
          data: { imageId: image.id, status: 'PENDING' },
        })

        await deps.imageScanQueue.add(
          'scan',
          { imageId: image.id, scanId: scan.id },
          { jobId: scan.id }, // dedupe: same scan id can't be added twice
        )

        // E6 / M3.10: post-push quota enforcement. The pre-push gate
        // in registry-token.ts is best-effort because Docker doesn't
        // declare layer sizes in the auth challenge. The webhook is
        // the authoritative check: at this point we know exactly how
        // much storage the user is consuming. If they're over, soft-
        // delete the just-pushed row so pulls fail and listings hide
        // it. The blobs stay in R2 until the registry's GC sweep
        // removes orphans.
        const quotaAfter = await getQuotaSnapshot(fastify.prisma, split.userId)
        if (quotaAfter.over) {
          await fastify.prisma.dockerImage.update({
            where: { id: image.id },
            data: {
              deletedAt: new Date(),
              pullBlocked: true,
              pullBlockReason:
                `Image push put account over storage quota ` +
                `(${quotaAfter.usedBytes.toString()} / ` +
                `${quotaAfter.limitBytes.toString()} bytes used). ` +
                `Delete older images to reclaim space.`,
            },
          })
          request.log.warn(
            {
              userId: split.userId,
              repo: split.repo,
              tag,
              usedBytes: quotaAfter.usedBytes.toString(),
              limitBytes: quotaAfter.limitBytes.toString(),
            },
            'registry webhook: post-push quota exceeded, soft-deleted image',
          )
        }

        processed++
      }

      request.log.info(
        { processed, skipped, total: payload.events.length },
        'registry webhook processed batch',
      )
      reply.send({ processed, skipped })
    },
  )
}
