import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { agentLogger } from './logger.js';

const log = agentLogger();

/**
 * Version info from the update server
 */
interface VersionInfo {
  version: string;
  downloadUrl: string;
  checksum: string;
}

/**
 * Self-Update Manager - Checks for and applies agent updates
 */
export class UpdateManager {
  private readonly currentVersion: string;
  private readonly updateUrl: string;
  private readonly installDir: string;
  private readonly binaryName: string;

  constructor(
    currentVersion: string,
    updateUrl: string,
    installDir: string = '/opt/a2e-agent'
  ) {
    this.currentVersion = currentVersion;
    this.updateUrl = updateUrl.replace(/\/$/, '');
    this.installDir = installDir;
    this.binaryName = `a2e-agent-linux-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`;
  }

  /**
   * Check if a newer version is available
   */
  async checkForUpdate(): Promise<VersionInfo | null> {
    try {
      const response = await fetch(`${this.updateUrl}/latest/version.json`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        log.debug({ status: response.status }, 'No update info available');
        return null;
      }

      const info = await response.json() as VersionInfo;

      if (this.isNewerVersion(info.version)) {
        log.info(
          { current: this.currentVersion, available: info.version },
          'New version available'
        );
        return info;
      }

      log.debug({ version: this.currentVersion }, 'Agent is up to date');
      return null;
    } catch (err) {
      log.debug({ error: (err as Error).message }, 'Failed to check for updates');
      return null;
    }
  }

  /**
   * Download and apply an update
   */
  async applyUpdate(versionInfo: VersionInfo): Promise<boolean> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2e-update-'));
    const downloadPath = path.join(tempDir, this.binaryName);

    try {
      // Download new binary
      log.info({ version: versionInfo.version }, 'Downloading update');
      const response = await fetch(versionInfo.downloadUrl, {
        signal: AbortSignal.timeout(300000), // 5 minute timeout for download
      });

      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(downloadPath, buffer, { mode: 0o755 });

      // Verify checksum
      if (versionInfo.checksum) {
        const { createHash } = await import('crypto');
        const hash = createHash('sha256').update(buffer).digest('hex');
        if (hash !== versionInfo.checksum) {
          throw new Error(`Checksum mismatch: expected ${versionInfo.checksum}, got ${hash}`);
        }
        log.info('Checksum verified');
      }

      // Replace the current binary
      const currentBinary = this.getCurrentBinaryPath();
      const backupPath = `${currentBinary}.backup`;

      // Backup current binary
      if (fs.existsSync(currentBinary)) {
        fs.copyFileSync(currentBinary, backupPath);
      }

      // Replace with new binary
      fs.copyFileSync(downloadPath, currentBinary);
      fs.chmodSync(currentBinary, 0o755);

      log.info({ version: versionInfo.version }, 'Update applied successfully');

      // Clean up temp files
      fs.rmSync(tempDir, { recursive: true, force: true });

      return true;
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to apply update');

      // Clean up temp files on failure
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }

      return false;
    }
  }

  /**
   * Restart the agent after update via systemd
   */
  restartAfterUpdate(): void {
    log.info('Restarting agent after update');

    // Create a restart script that runs after this process exits
    const restartScript = `#!/bin/bash
sleep 1
systemctl restart a2e-agent 2>/dev/null || true
rm -f /tmp/a2e-restart.sh
`;
    fs.writeFileSync('/tmp/a2e-restart.sh', restartScript, { mode: 0o755 });

    const child = spawn('/bin/bash', ['/tmp/a2e-restart.sh'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  /**
   * Compare semantic versions - returns true if remote is newer
   */
  private isNewerVersion(remote: string): boolean {
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
    const current = parse(this.currentVersion);
    const available = parse(remote);

    for (let i = 0; i < 3; i++) {
      const c = current[i] ?? 0;
      const a = available[i] ?? 0;
      if (a > c) return true;
      if (a < c) return false;
    }
    return false;
  }

  /**
   * Determine the path to the running binary
   */
  private getCurrentBinaryPath(): string {
    // Check common locations
    const candidates = [
      path.join(this.installDir, 'bin', 'a2e-agent'),
      '/usr/local/bin/a2e-agent',
      process.argv[0] ?? '/opt/a2e-agent/bin/a2e-agent',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return path.join(this.installDir, 'bin', 'a2e-agent');
  }
}
