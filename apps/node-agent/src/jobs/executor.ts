import { EventEmitter } from 'events';
import type { Job } from '../api/types.js';
import type { JobQueue } from './queue.js';
import type { JobReporter } from './reporter.js';
import { ContainerExecutor, type ContainerStats } from '../docker/executor.js';
import { ImageManager } from '../docker/image.js';
import type { DockerConfig, SecurityConfig } from '../config.js';
import { jobLogger } from '../utils/logger.js';

const log = jobLogger();

/**
 * Job Execution State
 */
export type JobState =
  | 'PENDING'
  | 'PULLING_IMAGE'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Active Job Info
 */
export interface ActiveJob {
  job: Job;
  state: JobState;
  startTime: Date;
  containerId?: string;
  output: string[];
  stats: ContainerStats[];
  lastStats?: ContainerStats;
}

/**
 * Job Executor Options
 */
export interface JobExecutorOptions {
  maxConcurrentJobs: number;
  maxOutputLines: number;
  statsInterval: number;
}

/**
 * Job Executor - Manages job execution lifecycle
 */
export class JobExecutor extends EventEmitter {
  private readonly queue: JobQueue;
  private readonly reporter: JobReporter;
  private readonly containerExecutor: ContainerExecutor;
  private readonly imageManager: ImageManager;
  private readonly options: JobExecutorOptions;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private running: boolean = false;
  private processTimer: NodeJS.Timeout | null = null;

  constructor(
    queue: JobQueue,
    reporter: JobReporter,
    dockerConfig: DockerConfig,
    securityConfig: SecurityConfig,
    options: Partial<JobExecutorOptions> = {}
  ) {
    super();
    this.queue = queue;
    this.reporter = reporter;
    this.containerExecutor = new ContainerExecutor(dockerConfig, securityConfig);
    this.imageManager = new ImageManager();
    this.options = {
      maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
      maxOutputLines: options.maxOutputLines ?? 1000,
      statsInterval: options.statsInterval ?? 5000,
    };

    // Forward container events
    this.containerExecutor.on('containerCreated', (data) => {
      this.emit('containerCreated', data);
    });
    this.containerExecutor.on('containerStarted', (data) => {
      this.emit('containerStarted', data);
    });
    this.containerExecutor.on('containerCompleted', (data) => {
      this.emit('containerCompleted', data);
    });
    this.containerExecutor.on('containerFailed', (data) => {
      this.emit('containerFailed', data);
    });
  }

  /**
   * Start the executor
   */
  start(): void {
    if (this.running) {
      log.warn('Executor already running');
      return;
    }

    log.info('Starting job executor');
    this.running = true;

    // Start processing loop
    this.processTimer = setInterval(() => {
      void this.processQueue();
    }, 1000);

    // Initial process
    void this.processQueue();
  }

  /**
   * Stop the executor
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    log.info('Stopping job executor');
    this.running = false;

    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }

    // Stop all active jobs
    await this.stopAllJobs();
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Check if we can run more jobs
    if (this.activeJobs.size >= this.options.maxConcurrentJobs) {
      return;
    }

    // Get next job from queue
    const job = this.queue.dequeue();
    if (!job) {
      return;
    }

    // Execute the job
    await this.executeJob(job);
  }

  /**
   * Execute a job
   */
  private async executeJob(job: Job): Promise<void> {
    const activeJob: ActiveJob = {
      job,
      state: 'PENDING',
      startTime: new Date(),
      output: [],
      stats: [],
    };

    this.activeJobs.set(job.id, activeJob);
    this.emit('jobStarted', job);

    try {
      // Report job started
      await this.reporter.reportStarted(job.id);
      activeJob.state = 'PULLING_IMAGE';

      // Pull image if needed
      log.info({ jobId: job.id, image: job.image }, 'Ensuring image available');
      await this.imageManager.ensure(job.image, (progress: { status: string }) => {
        log.debug({ jobId: job.id, status: progress.status }, 'Image pull progress');
      });

      activeJob.state = 'STARTING';

      // Execute container
      log.info({ jobId: job.id }, 'Starting container');
      activeJob.state = 'RUNNING';

      const result = await this.containerExecutor.execute({
        job,
        gpuDevices: job.gpuDevices ?? 'all',
        onLog: (stream, data) => {
          activeJob.output.push(`[${stream}] ${data}`);
          // Limit output buffer
          if (activeJob.output.length > this.options.maxOutputLines) {
            activeJob.output.shift();
          }
          this.emit('jobOutput', { jobId: job.id, stream, data });
        },
        onStats: (stats) => {
          activeJob.lastStats = stats;
          activeJob.stats.push(stats);
          // Limit stats buffer
          if (activeJob.stats.length > 100) {
            activeJob.stats.shift();
          }
        },
      });

      activeJob.containerId = result.containerId;
      activeJob.state = 'COMPLETED';

      // Report completion
      if (result.exitCode === 0) {
        log.info(
          { jobId: job.id, duration: result.duration, exitCode: result.exitCode },
          'Job completed successfully'
        );
        await this.reporter.reportCompleted(job.id, {
          exitCode: result.exitCode,
          duration: result.duration,
          output: result.output,
          peakMemory: result.stats?.peakMemory,
          avgCpu: result.stats?.avgCpuPercent,
        });
        this.emit('jobCompleted', { job, result });
      } else {
        log.warn(
          { jobId: job.id, exitCode: result.exitCode, error: result.error },
          'Job failed with non-zero exit code'
        );
        activeJob.state = 'FAILED';
        await this.reporter.reportFailed(job.id, {
          exitCode: result.exitCode,
          error: result.error ?? `Exit code: ${result.exitCode}`,
          output: result.output,
          retryable: this.isRetryableError(result.exitCode, result.error),
        });
        this.emit('jobFailed', { job, result });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error, jobId: job.id }, 'Job execution failed');
      activeJob.state = 'FAILED';

      await this.reporter.reportFailed(job.id, {
        exitCode: -1,
        error: errorMessage,
        output: activeJob.output.join('\n'),
        retryable: this.isRetryableError(-1, errorMessage),
      });
      this.emit('jobFailed', { job, error: errorMessage });

    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(exitCode: number, error?: string): boolean {
    // OOM killed
    if (exitCode === 137) {
      return false; // Usually not retryable as job needs more memory
    }

    // Timeout
    if (error?.includes('timed out')) {
      return false;
    }

    // Image pull errors
    if (error?.includes('pull') && error?.includes('error')) {
      return true; // Might be temporary network issue
    }

    // Docker daemon errors
    if (error?.includes('docker') && error?.includes('unavailable')) {
      return true;
    }

    // Default: non-zero exit codes are not retryable (application error)
    return exitCode === 0;
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string, reason: string = 'Cancelled by user'): Promise<boolean> {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) {
      // Check if in queue
      if (this.queue.remove(jobId)) {
        log.info({ jobId, reason }, 'Removed pending job from queue');
        return true;
      }
      log.warn({ jobId }, 'Job not found');
      return false;
    }

    log.info({ jobId, reason }, 'Cancelling job');
    activeJob.state = 'CANCELLED';

    // Stop the container
    await this.containerExecutor.stop(jobId, 10);

    // Report cancellation
    await this.reporter.reportFailed(jobId, {
      exitCode: -1,
      error: reason,
      output: activeJob.output.join('\n'),
      retryable: false,
    });

    this.activeJobs.delete(jobId);
    this.emit('jobCancelled', { job: activeJob.job, reason });

    return true;
  }

  /**
   * Stop all active jobs
   */
  private async stopAllJobs(): Promise<void> {
    const jobIds = Array.from(this.activeJobs.keys());
    log.info({ count: jobIds.length }, 'Stopping all active jobs');

    await Promise.all(
      jobIds.map(jobId => this.cancelJob(jobId, 'Agent shutting down'))
    );
  }

  /**
   * Get active job info
   */
  getActiveJob(jobId: string): ActiveJob | undefined {
    return this.activeJobs.get(jobId);
  }

  /**
   * Get all active jobs
   */
  getActiveJobs(): ActiveJob[] {
    return Array.from(this.activeJobs.values());
  }

  /**
   * Get current job count
   */
  getJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Check if a job is running
   */
  isJobRunning(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  /**
   * Check if executor is busy (at capacity)
   */
  isBusy(): boolean {
    return this.activeJobs.size >= this.options.maxConcurrentJobs;
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
}
