import { EventEmitter } from 'events';
import type { ApiClient } from '../api/client.js';
import type { Job, GpuTier } from '../api/types.js';
import { JobQueue } from './queue.js';
import { jobLogger } from '../utils/logger.js';

const log = jobLogger();

/**
 * Node Capabilities for polling
 */
export interface NodeCapabilities {
  gpuTier: GpuTier;
  gpuCount: number;
  availableVram: number;
}

/**
 * Job Poller Options
 */
export interface JobPollerOptions {
  pollIntervalMs: number;
  maxConcurrentJobs: number;
  acceptTimeout: number;
  agentVersion: string;
}

/**
 * Job Poller - Polls A²E for assigned jobs
 */
export class JobPoller extends EventEmitter {
  private readonly apiClient: ApiClient;
  private readonly queue: JobQueue;
  private readonly options: JobPollerOptions;
  private pollTimer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private nodeId: string | null = null;
  private capabilities: NodeCapabilities | null = null;

  constructor(
    apiClient: ApiClient,
    queue: JobQueue,
    options: Partial<JobPollerOptions> = {}
  ) {
    super();
    this.apiClient = apiClient;
    this.queue = queue;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 5000,
      maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
      acceptTimeout: options.acceptTimeout ?? 30000,
      agentVersion: options.agentVersion ?? '1.0.0',
    };
  }

  /**
   * Start polling
   */
  start(nodeId: string, capabilities: NodeCapabilities): void {
    if (this.running) {
      log.warn('Poller already running');
      return;
    }

    this.nodeId = nodeId;
    this.capabilities = capabilities;
    this.running = true;

    log.info(
      { nodeId, intervalMs: this.options.pollIntervalMs },
      'Starting job poller'
    );

    // Initial poll
    void this.poll();

    // Schedule periodic polling
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    log.info('Stopping job poller');
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll for jobs
   */
  private async poll(): Promise<void> {
    if (!this.running || !this.nodeId || !this.capabilities) {
      return;
    }

    // Don't poll if queue is full or already processing
    if (this.queue.isFull()) {
      log.debug('Queue is full, skipping poll');
      return;
    }

    try {
      log.debug('Polling for jobs');

      const response = await this.apiClient.pollJobs({
        status: this.queue.isProcessing() ? 'busy' : 'idle',
        capabilities: this.capabilities,
        agentVersion: this.options.agentVersion,
      });
      const jobs = response.job ? [response.job] : [];

      if (jobs.length === 0) {
        log.debug('No jobs available');
        return;
      }

      log.info({ jobCount: jobs.length }, 'Received jobs from server');

      // Process each job
      for (const job of jobs) {
        await this.processJob(job);
      }
    } catch (error) {
      log.error({ error }, 'Failed to poll for jobs');
      this.emit('pollError', error);
    }
  }

  /**
   * Process a job from the poll
   */
  private async processJob(job: Job): Promise<void> {
    // Check if we can accept this job
    if (!this.canAcceptJob(job)) {
      log.info({ jobId: job.id }, 'Cannot accept job, rejecting');
      await this.rejectJob(job, 'Node cannot handle this job type');
      return;
    }

    // Accept the job
    const accepted = await this.acceptJob(job);
    if (!accepted) {
      return;
    }

    // Add to queue
    const queued = this.queue.enqueue(job, job.priority ?? 0);
    if (!queued) {
      // Queue rejected it, need to notify server
      log.warn({ jobId: job.id }, 'Queue rejected job after acceptance');
      // Don't fail the job, just let it be reassigned
      return;
    }

    this.emit('jobQueued', job);
  }

  /**
   * Check if we can accept a job
   */
  private canAcceptJob(_job: Job): boolean {
    // Check if image is from a trusted registry (if configured)
    // This is a placeholder - actual implementation would check config

    // Check resource requirements
    // This is a placeholder - actual implementation would check GPU availability

    return true;
  }

  /**
   * Accept a job
   */
  private async acceptJob(job: Job): Promise<boolean> {
    try {
      log.info({ jobId: job.id }, 'Accepting job');
      await this.apiClient.acceptJob(job.id);
      this.emit('jobAccepted', job);
      return true;
    } catch (error) {
      log.error({ error, jobId: job.id }, 'Failed to accept job');
      this.emit('acceptError', { job, error });
      return false;
    }
  }

  /**
   * Reject a job
   */
  private async rejectJob(job: Job, reason: string): Promise<void> {
    try {
      log.info({ jobId: job.id, reason }, 'Rejecting job');
      await this.apiClient.rejectJob(job.id, reason);
      this.emit('jobRejected', { job, reason });
    } catch (error) {
      log.error({ error, jobId: job.id }, 'Failed to reject job');
    }
  }

  /**
   * Trigger immediate poll
   */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
}
