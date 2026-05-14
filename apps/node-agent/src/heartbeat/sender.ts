import type { Agent } from '../agent.js';
import { getApiClient } from '../api/client.js';
import type { HeartbeatRequest, NodeStatus, NodeCommand } from '../api/types.js';
import { UpdateManager } from '../utils/updater.js';
import { heartbeatLogger } from '../utils/logger.js';
import { SshSessionManager } from '../ssh/session-manager.js';

const log = heartbeatLogger();

/**
 * Heartbeat Service - Sends periodic heartbeats to A²E server
 */
export class HeartbeatService {
  private readonly agent: Agent;
  private readonly baseInterval: number;
  private interval: number;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private consecutiveFailures: number = 0;
  private readonly maxConsecutiveFailures: number = 5;
  private readonly maxBackoffMultiplier: number = 8; // Max 8x the base interval
  // Launch-blocker #2: handles SSH session lifecycle actions surfaced
  // by the API in heartbeat responses. Lazily constructed because the
  // API client is set up after the agent registers.
  private sshSessionManager: SshSessionManager | null = null;

  constructor(agent: Agent, intervalSeconds: number) {
    this.agent = agent;
    this.baseInterval = intervalSeconds * 1000;
    this.interval = this.baseInterval;
  }

  private getSshSessionManager(): SshSessionManager {
    if (!this.sshSessionManager) {
      this.sshSessionManager = new SshSessionManager(getApiClient());
    }
    return this.sshSessionManager;
  }

  /**
   * Start sending heartbeats
   */
  start(): void {
    if (this.running) {
      log.warn('Heartbeat service already running');
      return;
    }

    log.info({ intervalSeconds: this.interval / 1000 }, 'Starting heartbeat service');
    this.running = true;

    // Send first heartbeat immediately
    void this.sendHeartbeat();

    // Schedule periodic heartbeats
    this.timer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.interval);
  }

  /**
   * Stop sending heartbeats
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    log.info('Stopping heartbeat service');
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reschedule the heartbeat timer with a new interval
   */
  private rescheduleWithInterval(newInterval: number): void {
    this.interval = newInterval;

    if (this.running && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        void this.sendHeartbeat();
      }, this.interval);
    }
  }

  /**
   * Map agent state to node status
   */
  private getNodeStatus(): NodeStatus {
    const state = this.agent.getState();
    switch (state) {
      case 'ONLINE':
        return 'ONLINE';
      case 'BUSY':
        return 'ONLINE';
      case 'MAINTENANCE':
        return 'MAINTENANCE';
      case 'ERROR':
        return 'DEGRADED';
      default:
        return 'OFFLINE';
    }
  }

  /**
   * Send a heartbeat
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      const api = getApiClient();

      // Collect metrics
      const gpuMetrics = await this.agent.collectGpuMetrics();
      const systemMetrics = this.agent.collectSystemMetrics();

      const request: HeartbeatRequest = {
        status: this.getNodeStatus(),
        currentJobId: this.agent.getCurrentJobId() ?? undefined,
        gpuMetrics,
        systemMetrics,
        agentVersion: '1.0.0',
      };

      const response = await api.sendHeartbeat(request);

      // Reset failure counter and restore base interval on success
      if (this.consecutiveFailures > 0) {
        this.consecutiveFailures = 0;
        this.rescheduleWithInterval(this.baseInterval);
      }

      // Handle any commands from server
      if (response.commands && response.commands.length > 0) {
        for (const command of response.commands) {
          log.info({ command }, 'Received command from server');
          await this.handleCommand(command);
        }
      }

      // Apply config updates from server
      if (response.config) {
        log.info({ config: response.config }, 'Received config update from server');
        this.applyConfigUpdate(response.config);
      }

      // Launch-blocker #2: dispatch SSH lifecycle actions. dispatch() is
      // non-blocking (fire-and-forget); the session manager dedupes
      // in-flight ops and reports status via the API status callback.
      if (response.sshSession) {
        log.info(
          {
            action: response.sshSession.action,
            requestId: response.sshSession.requestId,
          },
          'Received SSH session action from server'
        );
        this.getSshSessionManager().dispatch(response.sshSession);
      }

      log.debug('Heartbeat sent successfully');
      this.agent.emit('heartbeatSent');
    } catch (error) {
      this.consecutiveFailures++;

      log.warn(
        {
          error: error instanceof Error ? error.message : error,
          consecutiveFailures: this.consecutiveFailures,
        },
        'Failed to send heartbeat'
      );

      this.agent.emit('heartbeatFailed', error instanceof Error ? error : new Error(String(error)));

      // Exponential backoff: double the interval on each failure, up to max
      const backoffMultiplier = Math.min(
        Math.pow(2, this.consecutiveFailures),
        this.maxBackoffMultiplier
      );
      const newInterval = this.baseInterval * backoffMultiplier;

      if (newInterval !== this.interval) {
        log.warn(
          { newIntervalMs: newInterval, failures: this.consecutiveFailures },
          'Increasing heartbeat interval due to failures'
        );
        this.rescheduleWithInterval(newInterval);
      }

      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        log.error('Too many consecutive heartbeat failures, running at reduced frequency');
      }
    }
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get consecutive failure count
   */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Apply configuration updates received from the server
   */
  private applyConfigUpdate(config: Record<string, unknown>): void {
    try {
      // Update heartbeat interval if provided
      if (typeof config.heartbeatInterval === 'number' && config.heartbeatInterval >= 10 && config.heartbeatInterval <= 300) {
        const newInterval = config.heartbeatInterval * 1000;
        if (newInterval !== this.interval) {
          log.info({ oldInterval: this.interval / 1000, newInterval: config.heartbeatInterval }, 'Updating heartbeat interval');
          this.rescheduleWithInterval(newInterval);
        }
      }

      // Update sandbox profile if provided
      if (typeof config.sandboxProfile === 'string') {
        log.info({ profile: config.sandboxProfile }, 'Server requests sandbox profile change (applied on next job)');
      }

      // Log any unrecognized config keys for transparency
      const knownKeys = new Set(['heartbeatInterval', 'sandboxProfile', 'jobPollInterval']);
      for (const key of Object.keys(config)) {
        if (!knownKeys.has(key)) {
          log.debug({ key, value: config[key] }, 'Unhandled config update key');
        }
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to apply config update');
    }
  }

  /**
   * Handle a command from the server
   */
  private async handleCommand(command: NodeCommand): Promise<void> {
    switch (command.type) {
      case 'UNINSTALL':
        log.info('Received UNINSTALL command, initiating self-removal...');
        this.stop(); // Stop heartbeats
        await this.agent.uninstall();
        break;

      case 'RESTART':
        log.info('Received RESTART command');
        await this.agent.restart();
        break;

      case 'PAUSE':
        log.info('Received PAUSE command');
        // TODO: Implement pause logic
        break;

      case 'RESUME':
        log.info('Received RESUME command');
        // TODO: Implement resume logic
        break;

      case 'DRAIN':
        log.info('Received DRAIN command');
        // TODO: Implement drain logic (stop accepting new jobs)
        break;

      case 'UPDATE':
        log.info('Received UPDATE command');
        await this.performUpdate(command.payload as { updateUrl?: string } | undefined);
        break;

      default:
        log.warn({ command }, 'Unknown command type');
    }
  }

  /**
   * Perform a self-update: check, download, apply, and restart
   */
  private async performUpdate(payload?: { updateUrl?: string }): Promise<void> {
    const updateUrl = payload?.updateUrl ?? 'https://a2e-api.onrender.com/releases';
    const updater = new UpdateManager('1.0.0', updateUrl);

    const versionInfo = await updater.checkForUpdate();
    if (!versionInfo) {
      log.info('No update available');
      return;
    }

    const applied = await updater.applyUpdate(versionInfo);
    if (applied) {
      log.info({ version: versionInfo.version }, 'Update applied, restarting');
      this.stop();
      updater.restartAfterUpdate();
    }
  }
}
