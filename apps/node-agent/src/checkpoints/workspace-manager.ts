/**
 * M3-T6: Workspace checkpoint manager.
 *
 * Handles two actions surfaced by the API heartbeat-response:
 *
 *   checkpoint -> tar+gzip the buyer's home directory, PUT to a
 *                 presigned S3 URL, report READY to the API.
 *
 *   restore    -> request a presigned GET URL for the prior rental's
 *                 snapshot, download, untar into the buyer's home
 *                 directory, report restore-applied to the API.
 *
 * Workspace convention: /home/<username> — created by the SSH session
 * manager when the rental's user is provisioned. Skipping the rest of
 * the filesystem keeps tarballs small (no system binaries, no
 * sandbox artifacts).
 *
 * Concurrency: at most one in-flight action per requestId. The agent
 * dispatches the same heartbeat-response field repeatedly until the
 * API stops surfacing it (status flips to READY/FAILED for snapshots,
 * restoreAppliedAt is set for restores), so a dedupe map keeps us
 * from kicking off duplicate uploads while one is still running.
 *
 * Failure handling: any agent-side error is reported back as FAILED
 * (or as a restore error) so the buyer UI surfaces it cleanly and
 * the heartbeat-response stops re-emitting the action.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ApiClient } from '../api/client.js'
import type { WorkspaceCheckpointAction } from '../api/types.js'

// Module-scoped log helper. The recovery logger is the natural home
// for checkpoint events alongside the existing job-recovery flow.
import { recoveryLogger } from '../utils/logger.js'

const log = recoveryLogger()

// Per-request dedupe. Set member while an action is in-flight; on
// completion (success or failure) we remove the entry so a future
// heartbeat-response can re-trigger if the API decides to.
const inFlight = new Set<string>()

function workspaceDir(username: string): string {
  // Hard-coded to /home/{username} to match the rental user the SSH
  // session-manager creates. Future change: read from a config file
  // dropped by the SSH manager so the two stay in sync without
  // duplicating the path constant.
  return path.join('/home', username)
}

/**
 * Run a child process and resolve on exit. Inherits stdio so any
 * tar/curl output lands in the agent's log stream for debugging.
 * Rejects on non-zero exit codes so the caller can mark the action
 * failed cleanly.
 */
function runChild(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout?.on('data', (b: Buffer) => log.debug({ cmd }, b.toString('utf8').trimEnd()))
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`))
    })
    child.on('error', reject)
  })
}

/**
 * Tar+gzip a directory to a temp file. Returns the temp file path on
 * success; caller is responsible for unlinking when done.
 *
 * Why shell tar instead of node-tar: streams reliably for multi-GB
 * workspaces, handles symlinks + sparse files correctly out of the
 * box, and avoids pulling in another dependency for the agent.
 */
async function tarWorkspace(dir: string): Promise<string> {
  const tmpFile = path.join('/tmp', `a2e-checkpoint-${Date.now()}.tar.gz`)
  // -C parent + leaf so paths inside the archive are relative to the
  // home dir rather than absolute. --exclude common cruft so we don't
  // bloat the snapshot with caches.
  await runChild('tar', [
    '-czf', tmpFile,
    '-C', path.dirname(dir),
    '--exclude', '*/.cache',
    '--exclude', '*/node_modules',
    '--exclude', '*/__pycache__',
    path.basename(dir),
  ])
  return tmpFile
}

/**
 * Stream a file to a presigned PUT URL. Uses fetch's body streaming
 * so we don't load the whole tarball into memory.
 */
async function putToPresignedUrl(filePath: string, url: string): Promise<void> {
  const stat = await fs.promises.stat(filePath)
  const stream = fs.createReadStream(filePath)
  // Cast through `unknown` to bypass lib.dom types that don't declare
  // duplex on RequestInit; undici (Node's runtime fetch) requires it
  // for streaming bodies.
  const init = {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(stat.size),
    },
    body: stream,
    duplex: 'half',
  } as unknown as RequestInit
  const resp = await fetch(url, init)
  if (!resp.ok) {
    throw new Error(`S3 PUT failed: ${resp.status} ${resp.statusText}`)
  }
}

/**
 * Download a presigned GET URL to a temp file. Returns the path.
 */
async function downloadFromPresignedUrl(url: string): Promise<string> {
  const tmpFile = path.join('/tmp', `a2e-restore-${Date.now()}.tar.gz`)
  const resp = await fetch(url)
  if (!resp.ok || !resp.body) {
    throw new Error(`S3 GET failed: ${resp.status} ${resp.statusText}`)
  }
  await pipeline(
    Readable.fromWeb(resp.body as never),
    fs.createWriteStream(tmpFile),
  )
  return tmpFile
}

/**
 * Untar an archive into the buyer's home directory. Strips the top-
 * level directory inside the archive so the contents land directly
 * under /home/{username} regardless of what the source rental's
 * username was.
 */
async function untarToWorkspace(archivePath: string, dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true })
  }
  await runChild('tar', [
    '-xzf', archivePath,
    '-C', dir,
    '--strip-components=1',
  ])
}

/**
 * Dispatch an inbound workspace-checkpoint action. Idempotent per
 * requestId: while one action is in-flight, subsequent calls with
 * the same requestId are dropped (the API keeps surfacing the action
 * on every heartbeat until our callback flips the row).
 */
export async function handleWorkspaceCheckpoint(
  api: ApiClient,
  action: WorkspaceCheckpointAction,
): Promise<void> {
  const dedupeKey = `${action.action}:${action.requestId}`
  if (inFlight.has(dedupeKey)) {
    log.debug({ action: action.action, requestId: action.requestId }, 'Checkpoint action already in-flight, skipping')
    return
  }
  inFlight.add(dedupeKey)
  try {
    if (action.action === 'checkpoint') {
      await runCheckpoint(api, action)
    } else {
      await runRestore(api, action)
    }
  } finally {
    inFlight.delete(dedupeKey)
  }
}

async function runCheckpoint(
  api: ApiClient,
  action: Extract<WorkspaceCheckpointAction, { action: 'checkpoint' }>,
): Promise<void> {
  const { requestId, username } = action
  const dir = workspaceDir(username)
  log.info({ requestId, username, dir }, 'Starting workspace checkpoint')

  let tmpFile: string | null = null
  try {
    // Report UPLOADING early so the buyer UI shows progress instead
    // of staying on REQUESTED through a multi-minute tar.
    await api.reportCheckpointStatus({ computeRequestId: requestId, status: 'UPLOADING' })

    tmpFile = await tarWorkspace(dir)
    log.info({ requestId, tmpFile }, 'Workspace tarred')

    const presign = await api.requestCheckpointUploadUrl(requestId)
    await putToPresignedUrl(tmpFile, presign.uploadUrl)
    log.info({ requestId, checkpointId: presign.checkpointId, bucketUrl: presign.bucketUrl }, 'Uploaded')

    await api.reportCheckpointStatus({
      computeRequestId: requestId,
      status: 'READY',
      bucketUrl: presign.bucketUrl,
      checkpointId: presign.checkpointId,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ requestId, error: msg }, 'Checkpoint failed')
    try {
      await api.reportCheckpointStatus({
        computeRequestId: requestId,
        status: 'FAILED',
        error: msg,
      })
    } catch (reportErr) {
      log.error({ requestId, error: reportErr }, 'Failed to report checkpoint failure')
    }
  } finally {
    if (tmpFile) {
      try { await fs.promises.unlink(tmpFile) } catch { /* best effort */ }
    }
  }
}

async function runRestore(
  api: ApiClient,
  action: Extract<WorkspaceCheckpointAction, { action: 'restore' }>,
): Promise<void> {
  const { requestId, username, checkpointId } = action
  const dir = workspaceDir(username)
  log.info({ requestId, username, dir, checkpointId }, 'Starting workspace restore')

  let tmpFile: string | null = null
  try {
    const presign = await api.requestCheckpointDownloadUrl(checkpointId)
    tmpFile = await downloadFromPresignedUrl(presign.downloadUrl)
    log.info({ requestId, tmpFile }, 'Checkpoint downloaded')

    await untarToWorkspace(tmpFile, dir)
    log.info({ requestId, dir }, 'Workspace restored')

    await api.reportRestoreApplied(requestId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ requestId, error: msg }, 'Restore failed')
    try {
      await api.reportRestoreApplied(requestId, msg)
    } catch (reportErr) {
      log.error({ requestId, error: reportErr }, 'Failed to report restore failure')
    }
  } finally {
    if (tmpFile) {
      try { await fs.promises.unlink(tmpFile) } catch { /* best effort */ }
    }
  }
}
