import { EventEmitter } from 'events';
import type { ApiClient } from '../api/client.js';
import { recoveryLogger } from '../utils/logger.js';

const log = recoveryLogger();

/**
 * Connection State
 */
export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

/**
 * Queued Update
 */
interface QueuedUpdate {
  type: 'heartbeat' | 'progress' | 'complete' | 'fail';
  jobId?: string;
  data: unknown;
  timestamp: Date;
  attempts: number;
}

/**
 * Reconnection Options
 */
export interface ReconnectOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  maxRetries: number;
  connectionTimeout: number;
  queueMaxSize: number;
}

const DEFAULT_OPTIONS: ReconnectOptions = {
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  maxRetries: 10,
  connectionTimeout: 30000,
  queueMaxSize: 100,
};

/**
 * Connection Recovery Manager - Handles connection loss and reconnection
 */
export class ConnectionRecoveryManager extends EventEmitter {
  private readonly apiClient: ApiClient;
  private readonly options: ReconnectOptions;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private updateQueue: QueuedUpdate[] = [];
  private lastSuccessfulConnection: Date | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;

  constructor(apiClient: ApiClient, options: Partial<ReconnectOptions> = {}) {
    super();
    this.apiClient = apiClient;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Start connection monitoring
   */
  start(): void {
    log.info('Starting connection recovery manager');

    // Monitor connection every 10 seconds
    this.monitorTimer = setInterval(() => {
      void this.checkConnection();
    }, 10000);

    // Initial check
    void this.checkConnection();
  }

  /**
   * Stop connection monitoring
   */
  stop(): void {
    log.info('Stopping connection recovery manager');

    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Check connection by attempting a health check
   */
  private async checkConnection(): Promise<void> {
    if (this.state === 'reconnecting') {
      return; // Already trying to reconnect
    }

    try {
      // Try to fetch remote config as a health check
      await this.apiClient.getRemoteConfig();

      if (this.state === 'disconnected') {
        this.handleConnectionRestored();
      }
    } catch (error) {
      if (this.state === 'connected') {
        this.handleConnectionLost();
      }
    }
  }

  /**
   * Handle connection loss
   */
  private handleConnectionLost(): void {
    log.warn('Connection to A²E server lost');
    this.state = 'disconnected';
    this.emit('disconnected');

    // Start reconnection attempts
    this.scheduleReconnect();
  }

  /**
   * Handle connection restored
   */
  private handleConnectionRestored(): void {
    log.info('Connection to A²E server restored');
    this.state = 'connected';
    this.reconnectAttempts = 0;
    this.lastSuccessfulConnection = new Date();
    this.emit('connected');

    // Flush queued updates
    void this.flushQueue();
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxRetries) {
      log.error(
        { attempts: this.reconnectAttempts },
        'Max reconnection attempts reached'
      );
      this.emit('maxRetriesReached');
      return;
    }

    this.state = 'reconnecting';

    const delay = Math.min(
      this.options.initialDelayMs * Math.pow(this.options.backoffMultiplier, this.reconnectAttempts),
      this.options.maxDelayMs
    );

    log.info(
      { attempt: this.reconnectAttempts + 1, delayMs: delay },
      'Scheduling reconnection attempt'
    );

    this.reconnectTimer = setTimeout(() => {
      void this.attemptReconnect();
    }, delay);
  }

  /**
   * Attempt to reconnect
   */
  private async attemptReconnect(): Promise<void> {
    this.reconnectAttempts++;

    log.info({ attempt: this.reconnectAttempts }, 'Attempting to reconnect');

    try {
      await this.apiClient.getRemoteConfig();

      // Success
      this.handleConnectionRestored();
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : 'Unknown', attempt: this.reconnectAttempts },
        'Reconnection attempt failed'
      );
      this.emit('reconnectFailed', { attempt: this.reconnectAttempts, error });

      // Schedule next attempt
      this.state = 'disconnected';
      this.scheduleReconnect();
    }
  }

  /**
   * Queue an update for later delivery
   */
  queueUpdate(type: QueuedUpdate['type'], jobId?: string, data?: unknown): void {
    if (this.updateQueue.length >= this.options.queueMaxSize) {
      // Remove oldest update
      const removed = this.updateQueue.shift();
      log.warn({ removed: removed?.type }, 'Update queue full, dropping oldest');
    }

    this.updateQueue.push({
      type,
      jobId,
      data,
      timestamp: new Date(),
      attempts: 0,
    });

    log.debug(
      { type, jobId, queueSize: this.updateQueue.length },
      'Update queued for delivery'
    );
  }

  /**
   * Flush queued updates
   */
  private async flushQueue(): Promise<void> {
    if (this.updateQueue.length === 0) {
      return;
    }

    log.info({ count: this.updateQueue.length }, 'Flushing queued updates');

    const updates = [...this.updateQueue];
    this.updateQueue = [];

    for (const update of updates) {
      try {
        await this.sendUpdate(update);
        log.debug({ type: update.type, jobId: update.jobId }, 'Queued update sent');
      } catch (error) {
        log.warn(
          { error: error instanceof Error ? error.message : 'Unknown', type: update.type },
          'Failed to send queued update'
        );

        // Re-queue if retries remaining
        if (update.attempts < 3) {
          update.attempts++;
          this.updateQueue.push(update);
        }
      }
    }
  }

  /**
   * Send a queued update
   */
  private async sendUpdate(update: QueuedUpdate): Promise<void> {
    switch (update.type) {
      case 'heartbeat':
        // Heartbeats that were queued are stale, skip them
        break;

      case 'progress':
        if (update.jobId && update.data) {
          await this.apiClient.reportProgress(update.jobId, update.data as { progress: number; message?: string });
        }
        break;

      case 'complete':
        if (update.jobId && update.data) {
          await this.apiClient.reportComplete(update.jobId, update.data as {
            exitCode: number;
            duration: number;
            output?: string;
          });
        }
        break;

      case 'fail':
        if (update.jobId && update.data) {
          await this.apiClient.reportFailure(update.jobId, update.data as {
            error: string;
            exitCode?: number;
            logs?: string;
            retryable?: boolean;
          });
        }
        break;
    }
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.updateQueue.length;
  }

  /**
   * Get reconnection attempts
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Get last successful connection time
   */
  getLastConnectionTime(): Date | null {
    return this.lastSuccessfulConnection;
  }

  /**
   * Mark connection as established (call after successful API operation)
   */
  markConnected(): void {
    if (this.state !== 'connected') {
      this.handleConnectionRestored();
    } else {
      this.lastSuccessfulConnection = new Date();
    }
  }

  /**
   * Mark connection as lost (call after failed API operation)
   */
  markDisconnected(): void {
    if (this.state === 'connected') {
      this.handleConnectionLost();
    }
  }

  /**
   * Reset reconnection attempts
   */
  resetAttempts(): void {
    this.reconnectAttempts = 0;
  }
}
