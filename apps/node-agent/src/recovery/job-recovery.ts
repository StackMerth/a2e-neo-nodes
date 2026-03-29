import { EventEmitter } from 'events';
import type Docker from 'dockerode';
import { getDockerClient } from '../docker/client.js';
import type { StateManager, AgentState } from './state.js';
import type { JobReporter } from '../jobs/reporter.js';
import { CleanupManager } from '../docker/cleanup.js';
import { recoveryLogger } from '../utils/logger.js';

const log = recoveryLogger();

/**
 * Recovery Result
 */
export interface RecoveryResult {
  incompleteJobFound: boolean;
  jobId?: string;
  containerId?: string;
  action: 'resumed' | 'reported_failed' | 'cleaned_up' | 'none';
  containerState?: string;
  error?: string;
}

/**
 * Job Recovery Manager - Handles recovery of incomplete jobs after restart
 */
export class JobRecoveryManager extends EventEmitter {
  private readonly stateManager: StateManager;
  private readonly reporter: JobReporter;
  private readonly cleanupManager: CleanupManager;

  constructor(stateManager: StateManager, reporter: JobReporter) {
    super();
    this.stateManager = stateManager;
    this.reporter = reporter;
    this.cleanupManager = new CleanupManager();
  }

  /**
   * Perform recovery check on startup
   */
  async recover(): Promise<RecoveryResult> {
    log.info('Checking for incomplete jobs from previous run');

    const incompleteJob = this.stateManager.getIncompleteJob();

    if (!incompleteJob) {
      log.info('No incomplete jobs found');

      // Still clean up any orphaned containers
      await this.cleanupOrphans();

      return {
        incompleteJobFound: false,
        action: 'none',
      };
    }

    log.info(
      { jobId: incompleteJob.jobId, containerId: incompleteJob.containerId },
      'Found incomplete job, checking container state'
    );

    try {
      const result = await this.handleIncompleteJob(incompleteJob);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error, jobId: incompleteJob.jobId }, 'Recovery failed');

      // Report failure and clean up
      await this.reportJobFailed(incompleteJob.jobId, `Recovery failed: ${errorMessage}`);
      this.stateManager.clearCurrentJob();
      await this.stateManager.save();

      return {
        incompleteJobFound: true,
        jobId: incompleteJob.jobId,
        containerId: incompleteJob.containerId,
        action: 'reported_failed',
        error: errorMessage,
      };
    }
  }

  /**
   * Handle an incomplete job
   */
  private async handleIncompleteJob(
    incompleteJob: NonNullable<AgentState['currentJob']>
  ): Promise<RecoveryResult> {
    const { jobId, containerId, startedAt } = incompleteJob;
    const client = getDockerClient();

    // Check if container still exists
    let container: Docker.Container;
    let containerInfo: Docker.ContainerInspectInfo;

    try {
      container = client.getContainer(containerId);
      containerInfo = await container.inspect();
    } catch (error) {
      // Container doesn't exist
      log.warn({ jobId, containerId }, 'Container not found, reporting job as failed');

      await this.reportJobFailed(jobId, 'Container not found after agent restart');
      this.stateManager.clearCurrentJob();
      await this.stateManager.save();

      return {
        incompleteJobFound: true,
        jobId,
        containerId,
        action: 'reported_failed',
        error: 'Container not found',
      };
    }

    const containerState = containerInfo.State?.Status ?? 'unknown';
    log.info({ jobId, containerId, containerState }, 'Container found, checking state');

    switch (containerState) {
      case 'running':
        // Container is still running - this is unexpected after restart
        // Agent may have crashed while job was running
        // For safety, stop the container and report failure
        log.warn({ jobId, containerId }, 'Container still running after restart, stopping');

        await this.stopAndCleanupContainer(container, jobId);
        await this.reportJobFailed(jobId, 'Agent restarted while job was running');
        this.stateManager.clearCurrentJob();
        await this.stateManager.save();

        return {
          incompleteJobFound: true,
          jobId,
          containerId,
          action: 'reported_failed',
          containerState,
        };

      case 'exited':
      case 'dead':
        // Container finished - get exit code and report
        const exitCode = containerInfo.State?.ExitCode ?? -1;
        log.info({ jobId, containerId, exitCode }, 'Container exited, reporting result');

        // Get logs for output
        const logs = await this.getContainerLogs(container);

        // Calculate approximate duration
        const startTime = new Date(startedAt).getTime();
        const finishedAt = containerInfo.State?.FinishedAt;
        const endTime = finishedAt ? new Date(finishedAt).getTime() : Date.now();
        const duration = Math.floor((endTime - startTime) / 1000);

        if (exitCode === 0) {
          await this.reporter.reportCompleted(jobId, {
            exitCode,
            duration,
            output: logs,
          });
        } else {
          await this.reporter.reportFailed(jobId, {
            exitCode,
            error: `Job exited with code ${exitCode} (recovered after restart)`,
            output: logs,
            retryable: false,
          });
        }

        // Clean up container
        await this.removeContainer(container);
        this.stateManager.clearCurrentJob();
        await this.stateManager.save();

        return {
          incompleteJobFound: true,
          jobId,
          containerId,
          action: exitCode === 0 ? 'cleaned_up' : 'reported_failed',
          containerState,
        };

      case 'created':
        // Container was created but never started
        log.warn({ jobId, containerId }, 'Container created but never started');

        await this.removeContainer(container);
        await this.reportJobFailed(jobId, 'Container was never started (agent crashed during startup)');
        this.stateManager.clearCurrentJob();
        await this.stateManager.save();

        return {
          incompleteJobFound: true,
          jobId,
          containerId,
          action: 'reported_failed',
          containerState,
        };

      case 'paused':
        // Unpause, then stop
        log.warn({ jobId, containerId }, 'Container paused, stopping');

        try {
          await container.unpause();
        } catch {
          // Ignore unpause errors
        }
        await this.stopAndCleanupContainer(container, jobId);
        await this.reportJobFailed(jobId, 'Container was paused when agent restarted');
        this.stateManager.clearCurrentJob();
        await this.stateManager.save();

        return {
          incompleteJobFound: true,
          jobId,
          containerId,
          action: 'reported_failed',
          containerState,
        };

      default:
        log.warn({ jobId, containerId, containerState }, 'Unknown container state');

        await this.stopAndCleanupContainer(container, jobId);
        await this.reportJobFailed(jobId, `Unknown container state: ${containerState}`);
        this.stateManager.clearCurrentJob();
        await this.stateManager.save();

        return {
          incompleteJobFound: true,
          jobId,
          containerId,
          action: 'reported_failed',
          containerState,
        };
    }
  }

  /**
   * Stop and cleanup a container
   */
  private async stopAndCleanupContainer(container: Docker.Container, jobId: string): Promise<void> {
    try {
      await container.stop({ t: 10 });
    } catch {
      // Container may already be stopped
    }

    try {
      await container.remove({ force: true, v: true });
    } catch (error) {
      log.warn({ error, jobId }, 'Failed to remove container');
    }
  }

  /**
   * Remove a container
   */
  private async removeContainer(container: Docker.Container): Promise<void> {
    try {
      await container.remove({ force: true, v: true });
    } catch (error) {
      log.warn({ error }, 'Failed to remove container');
    }
  }

  /**
   * Get container logs
   */
  private async getContainerLogs(container: Docker.Container): Promise<string> {
    try {
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: 1000,
        timestamps: false,
      });
      return logs.toString('utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Report a job as failed
   */
  private async reportJobFailed(jobId: string, error: string): Promise<void> {
    try {
      await this.reporter.reportFailed(jobId, {
        exitCode: -1,
        error,
        output: '',
        retryable: true, // Recovery failures are generally retryable
      });
    } catch (reportError) {
      log.error({ error: reportError, jobId }, 'Failed to report job failure during recovery');
    }
  }

  /**
   * Clean up orphaned containers
   */
  private async cleanupOrphans(): Promise<void> {
    try {
      const orphaned = await this.cleanupManager.findOrphanedContainers();
      if (orphaned.length > 0) {
        log.info({ count: orphaned.length }, 'Found orphaned containers, cleaning up');
        await this.cleanupManager.cleanupOrphanedContainers();
      }
    } catch (error) {
      log.warn({ error }, 'Failed to clean up orphaned containers');
    }
  }
}
