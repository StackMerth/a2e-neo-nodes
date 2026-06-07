/**
 * io.net post-provision tenant-isolation cleanup.
 *
 * Real-world failure mode that motivated this (rental cmq3p1gt0000,
 * 2026-06-07): an io.net H100 1x rental landed on a SHARED host where
 * the home directory was NOT wiped between tenants. SSH'ing in showed:
 *
 *   Last login: Fri Jan 16 18:18:49 2026 from 71.62.8.247
 *
 * That's the previous tenant's source IP visible to the next renter.
 * Worse, .bash_history, ~/.aws/credentials, ~/.gcp/, ~/.docker/config,
 * etc. from prior tenants would likely also persist. This is a hard
 * launch blocker: a buyer's competitor could rent the same host after
 * them and read their command history, env files, and possibly
 * credentials.
 *
 * Fix: after io.net reports the deployment ACTIVE + sshHost populated,
 * SSH in WITH OUR EPHEMERAL KEY (which io.net injected at deploy time)
 * and run a cleanup script that wipes prior-tenant residue. This must
 * happen BEFORE we promote the ComputeRequest to ACTIVE in the portal,
 * so the buyer's first login sees a clean machine.
 *
 * What gets wiped:
 *   - Shell histories (.bash_history / .zsh_history / .python_history /
 *     .lesshst / .viminfo / .mysql_history / .psql_history)
 *   - SSH state EXCEPT authorized_keys (which contains OUR key for
 *     this rental). Wipes known_hosts so prior tenant's "I SSH'd to X"
 *     trail is gone.
 *   - Cloud credentials: .aws, .gcp, .azure, .docker, .kube, .gnupg,
 *     .config/gcloud (the high-value targets)
 *   - Caches: .cache, .local/state, .npm/_logs, .pip, .conda, .jupyter
 *   - Editor state: .vscode-server, .cursor-server
 *   - Git/tool configs: .gitconfig, .npmrc, .yarnrc, .pypirc
 *   - /tmp + /var/tmp
 *   - With sudo: /var/log/lastlog, /var/log/wtmp, /var/log/btmp,
 *     /var/log/auth.log, /root/{.bash_history,.cache,.docker,.aws}
 *
 * What gets PRESERVED:
 *   - .ssh/authorized_keys (our SSH key for this rental)
 *   - .bashrc / .profile / .zshrc (image defaults the buyer might
 *     need; replacing these could break login)
 *   - All /opt, /usr, /etc system paths (image-level config)
 *
 * Fails open: if cleanup throws (SSH refused, command times out,
 * etc.), we log the failure and proceed to mark the rental ACTIVE
 * anyway. Reason: blocking the buyer's rental on a flaky cleanup is
 * worse than the residual-data risk for v1. Future hardening: retry
 * the cleanup up to N times before failing open, OR fail closed when
 * a strict-isolation buyer flag is set.
 *
 * Sets ExternalRental.lastNote so we can tell from the row whether
 * cleanup ran (and if not, why). Idempotent: if lastNote indicates
 * cleanup already succeeded, we skip the SSH round-trip.
 */

import type { PrismaClient } from '@a2e/database'
import { SSHClient } from '../provisioning/ssh-client.js'
import { decryptPrivateKey } from './key-encryption.js'

export const CLEANUP_SUCCESS_NOTE = 'tenant_cleanup_complete'
export const CLEANUP_FAILED_NOTE_PREFIX = 'tenant_cleanup_failed:'

const CLEANUP_SCRIPT = `
cd "$HOME" 2>/dev/null || cd /

# 1. Shell histories
rm -f .bash_history .zsh_history .fish_history .python_history \\
  .lesshst .viminfo .nano_history .mysql_history .psql_history \\
  .node_repl_history .rediscli_history .sqlite_history 2>/dev/null

# 2. SSH state (preserve authorized_keys which holds OUR key)
rm -f .ssh/known_hosts .ssh/known_hosts.old 2>/dev/null
# Prior tenant's private keys, if any
find .ssh -maxdepth 1 -type f ! -name 'authorized_keys' ! -name 'authorized_keys2' \\
  -delete 2>/dev/null

# 3. Cloud + dev credentials (high-value targets)
rm -rf .aws .gcp .azure .docker .kube .gnupg .ssh_keys 2>/dev/null
rm -rf .config/gcloud .config/gh .config/hub 2>/dev/null

# 4. Caches and state
rm -rf .cache .local/state .npm/_logs .pip .conda .jupyter \\
  .vim/.viminfo .ipython 2>/dev/null

# 5. Editor / IDE server state
rm -rf .vscode-server .vscode-remote .cursor-server \\
  .config/Code 2>/dev/null

# 6. Tool configs that may contain creds or identity
rm -f .gitconfig .git-credentials .npmrc .yarnrc .pypirc .netrc 2>/dev/null

# 7. Random tenant work that might be in /tmp
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true

# 8. Last-login records (require sudo). Use \`sudo -n\` (no password
#    prompt). If passwordless sudo isn't available we just skip these.
if sudo -n true 2>/dev/null; then
  sudo truncate -s 0 /var/log/lastlog 2>/dev/null || true
  sudo truncate -s 0 /var/log/wtmp 2>/dev/null || true
  sudo truncate -s 0 /var/log/btmp 2>/dev/null || true
  sudo rm -f /var/log/auth.log* /var/log/secure* /var/log/syslog* 2>/dev/null || true
  sudo rm -rf /root/.bash_history /root/.cache /root/.docker \\
    /root/.aws /root/.gcp /root/.azure /root/.kube /root/.gnupg 2>/dev/null || true
fi

# Wipe the current shell's history buffer too so 'history' in next
# session shows clean.
history -c 2>/dev/null || true

echo "${CLEANUP_SUCCESS_NOTE}"
`.trim()

export interface CleanupResult {
  ok: boolean
  /** Truthy success marker ('tenant_cleanup_complete') if the script ran. */
  successMarker: string | null
  /** Error text if cleanup failed. */
  error?: string
  /** ms spent on the SSH round-trip + script execution. */
  durationMs: number
}

export async function cleanupIoNetTenant(
  prisma: PrismaClient,
  externalRentalId: string,
): Promise<CleanupResult> {
  const t0 = Date.now()
  const row = await prisma.externalRental.findUnique({
    where: { id: externalRentalId },
    select: {
      id: true,
      provider: true,
      sshHost: true,
      sshPort: true,
      sshUsername: true,
      sshPrivateKeyEnc: true,
      lastNote: true,
    },
  })
  if (!row) {
    return {
      ok: false,
      successMarker: null,
      error: `ExternalRental ${externalRentalId} not found`,
      durationMs: Date.now() - t0,
    }
  }
  if (row.provider !== 'IONET') {
    return {
      ok: false,
      successMarker: null,
      error: `Provider ${row.provider} is not IONET; cleanup is io.net-specific`,
      durationMs: Date.now() - t0,
    }
  }
  if (!row.sshHost) {
    return {
      ok: false,
      successMarker: null,
      error: 'sshHost not yet populated; poll worker should retry on next tick',
      durationMs: Date.now() - t0,
    }
  }
  // Idempotency: if cleanup already succeeded, skip the SSH round-trip.
  if (row.lastNote === CLEANUP_SUCCESS_NOTE) {
    return {
      ok: true,
      successMarker: CLEANUP_SUCCESS_NOTE,
      durationMs: Date.now() - t0,
    }
  }

  const privateKey = decryptPrivateKey(row.sshPrivateKeyEnc)
  const client = new SSHClient()

  try {
    await client.connect({
      host: row.sshHost,
      port: row.sshPort,
      username: row.sshUsername,
      authMethod: 'privateKey',
      privateKey,
    })

    // Script is run via bash -c so the heredoc-like multi-line behavior
    // works the same as if a buyer pasted it into their own shell. We
    // wrap in bash -lc to source the standard profile (PATH, etc.) so
    // commands like sudo, truncate, find resolve.
    const result = await client.exec(`bash -lc ${shellEscape(CLEANUP_SCRIPT)}`, 30000)

    const successMarker = result.stdout.includes(CLEANUP_SUCCESS_NOTE)
      ? CLEANUP_SUCCESS_NOTE
      : null

    client.disconnect()

    if (successMarker) {
      await prisma.externalRental.update({
        where: { id: externalRentalId },
        data: { lastNote: CLEANUP_SUCCESS_NOTE },
      })
      return { ok: true, successMarker, durationMs: Date.now() - t0 }
    }

    // Script ran but didn't emit the success marker. Log what we got
    // for triage and treat as failure (fail-open at the caller).
    const err = `Cleanup script returned exit=${result.code} without success marker. `
      + `stdout=${result.stdout.slice(0, 200)} stderr=${result.stderr.slice(0, 200)}`
    await prisma.externalRental.update({
      where: { id: externalRentalId },
      data: { lastNote: `${CLEANUP_FAILED_NOTE_PREFIX}${err.slice(0, 240)}` },
    })
    return { ok: false, successMarker: null, error: err, durationMs: Date.now() - t0 }
  } catch (err) {
    try {
      client.disconnect()
    } catch {
      // ignore
    }
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.externalRental.update({
      where: { id: externalRentalId },
      data: { lastNote: `${CLEANUP_FAILED_NOTE_PREFIX}${msg.slice(0, 240)}` },
    })
    return { ok: false, successMarker: null, error: msg, durationMs: Date.now() - t0 }
  }
}

/**
 * Shell-quote a multi-line string for safe embedding in `bash -c '...'`.
 * Replaces single quotes with the standard escape pattern so the script
 * body can contain arbitrary characters except a literal escape sequence.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}
