import type { Agent } from '../agent.js';
import { getApiClient } from '../api/client.js';
import type { HeartbeatRequest, NodeStatus, NodeCommand } from '../api/types.js';
import { heartbeatLogger } from '../utils/logger.js';

const log = heartbeatLogger();

/**
 * Heartbeat Service - Sends periodic heartbeats to A²E server
 */
export class HeartbeatService {
  private readonly agent: Agent;
  private readonly interval: number;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private consecutiveFailures: number = 0;
  private readonly maxConsecutiveFailures: number = 5;

  constructor(agent: Agent, intervalSeconds: number) {
    this.agent = agent;
    this.interval = intervalSeconds * 1000;
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

      // Reset failure counter on success
      this.consecutiveFailures = 0;

      // Handle any commands from server
      if (response.commands && response.commands.length > 0) {
        for (const command of response.commands) {
          log.info({ command }, 'Received command from server');
          await this.handleCommand(command);
        }
      }

      // Update config if server provides new values
      if (response.config) {
        log.debug({ config: response.config }, 'Received config update from server');
        // TODO: Apply config updates
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

      // If too many failures, increase interval temporarily
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        log.error('Too many consecutive heartbeat failures');
        // Don't stop, but the agent may want to handle this
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
        // TODO: Implement self-update logic
        break;

      default:
        log.warn({ command }, 'Unknown command type');
    }
  }
}
