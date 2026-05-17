/**
 * M3-T6: Workspace checkpoint S3 service.
 *
 * Issues presigned URLs that the node-agent uses to upload (after the
 * buyer requests a checkpoint) or download (when a new rental is
 * being restored from a prior rental's snapshot). Direct agent → S3
 * keeps multi-GB file transfers off the API process.
 *
 * Configuration is env-driven:
 *   CHECKPOINT_S3_BUCKET           (required to enable feature)
 *   CHECKPOINT_S3_REGION           (default: us-east-1)
 *   CHECKPOINT_S3_ENDPOINT         (optional, for S3-compatible services)
 *   CHECKPOINT_AWS_ACCESS_KEY_ID   (required)
 *   CHECKPOINT_AWS_SECRET_ACCESS_KEY (required)
 *   CHECKPOINT_PRESIGN_TTL_SECONDS (default: 3600 = 1h)
 *
 * If the bucket env is unset, `isCheckpointS3Configured()` returns
 * false and the route handlers return 503 with a clear message
 * pointing admin at the runbook section on workspace checkpoints.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const BUCKET = process.env.CHECKPOINT_S3_BUCKET
const REGION = process.env.CHECKPOINT_S3_REGION ?? 'us-east-1'
const ENDPOINT = process.env.CHECKPOINT_S3_ENDPOINT
const ACCESS_KEY = process.env.CHECKPOINT_AWS_ACCESS_KEY_ID
const SECRET_KEY = process.env.CHECKPOINT_AWS_SECRET_ACCESS_KEY
const PRESIGN_TTL = Number(process.env.CHECKPOINT_PRESIGN_TTL_SECONDS ?? 3600)

let client: S3Client | null = null

function getClient(): S3Client {
  if (!client) {
    if (!ACCESS_KEY || !SECRET_KEY) {
      // Should never reach here if isCheckpointS3Configured guards the
      // call sites, but defend anyway in case future code paths skip
      // the check.
      throw new Error('Checkpoint S3 credentials not configured')
    }
    client = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
      },
      // forcePathStyle helps with S3-compatible backends like Minio
      // when CHECKPOINT_S3_ENDPOINT is set. Standard AWS is fine
      // either way.
      forcePathStyle: !!ENDPOINT,
    })
  }
  return client
}

/** Returns true when the env wiring is sufficient to issue presigned URLs. */
export function isCheckpointS3Configured(): boolean {
  return Boolean(BUCKET && ACCESS_KEY && SECRET_KEY)
}

/**
 * Build the canonical S3 object key for a given checkpoint. Keying by
 * nodeRunnerId + computeRequestId lets admin filter / audit a single
 * operator or rental quickly via the S3 console, and prevents cross-
 * operator collisions.
 */
export function checkpointObjectKey(
  nodeRunnerId: string,
  computeRequestId: string,
  checkpointId: string,
): string {
  return `checkpoints/${nodeRunnerId}/${computeRequestId}/${checkpointId}.tar.gz`
}

/**
 * Returns a presigned PUT URL for the agent to upload a new
 * checkpoint. The agent receives this from the heartbeat-response
 * indirectly: the API issues a fresh URL each time the agent calls
 * POST /v1/agent/checkpoints/upload-url with the requestId + a
 * client-generated checkpointId.
 */
export async function presignCheckpointUpload(
  nodeRunnerId: string,
  computeRequestId: string,
  checkpointId: string,
): Promise<{ uploadUrl: string; objectKey: string; bucketUrl: string; expiresAt: string }> {
  const objectKey = checkpointObjectKey(nodeRunnerId, computeRequestId, checkpointId)
  const cmd = new PutObjectCommand({
    Bucket: BUCKET!,
    Key: objectKey,
    ContentType: 'application/gzip',
  })
  const uploadUrl = await getSignedUrl(getClient(), cmd, { expiresIn: PRESIGN_TTL })
  // Canonical s3:// URL stored on the ComputeRequest row. Resolves
  // back to bucket + key without needing to re-derive the convention.
  const bucketUrl = `s3://${BUCKET}/${objectKey}`
  const expiresAt = new Date(Date.now() + PRESIGN_TTL * 1000).toISOString()
  return { uploadUrl, objectKey, bucketUrl, expiresAt }
}

/**
 * Returns a presigned GET URL for the agent to download an existing
 * checkpoint. Used during rental restore.
 *
 * Throws if the object doesn't exist in S3 yet — protects against the
 * race where the buyer references a checkpointId whose upload never
 * completed (status=FAILED or still UPLOADING). Caller should map
 * the throw to a 404 / 409.
 */
export async function presignCheckpointDownload(
  bucketUrl: string,
): Promise<{ downloadUrl: string; expiresAt: string }> {
  // bucketUrl is the s3://bucket/key form stored on the rental row.
  // Parse it back into bucket + key.
  if (!bucketUrl.startsWith('s3://')) {
    throw new Error(`Invalid bucket URL: ${bucketUrl}`)
  }
  const withoutScheme = bucketUrl.slice('s3://'.length)
  const slashIdx = withoutScheme.indexOf('/')
  if (slashIdx < 0) {
    throw new Error(`Invalid bucket URL (missing key): ${bucketUrl}`)
  }
  const bucket = withoutScheme.slice(0, slashIdx)
  const key = withoutScheme.slice(slashIdx + 1)

  // Probe the object exists. HEAD is cheap and tells us early if the
  // checkpoint isn't ready (404 in S3 → throws here → caller returns 404).
  await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))

  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
  const downloadUrl = await getSignedUrl(getClient(), cmd, { expiresIn: PRESIGN_TTL })
  const expiresAt = new Date(Date.now() + PRESIGN_TTL * 1000).toISOString()
  return { downloadUrl, expiresAt }
}
