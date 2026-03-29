import type { ApiClient } from '../api/client.js';
import { jobLogger } from '../utils/logger.js';

const log = jobLogger();

/**
 * Job Completion Data
 */
export interface JobCompletionData {
  exitCode: number;
  duration: number;
  output: string;
  peakMemory?: number;
  avgCpu?: number;
}

/**
 * Job Failure Data
 */
export interface JobFailureData {
  exitCode: number;
  error: string;
  output: string;
  retryable: boolean;
}

/**
 * Pending Report
 */
interface PendingReport {
  jobId: string;
  type: 'started' | 'progress' | 'completed' | 'failed';
  data: unknown;
  attempts: number;
  lastAttempt: Date | null;
}

/**
 * Job Reporter - Reports job status to A²E server
 */
export class JobReporter {
  private readonly apiClient: ApiClient;
  private pendingReports: PendingReport[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly maxRetries: number = 5;
  private readonly retryDelayMs: number = 5000;

  constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }

  /**
   * Start the reporter (for retry processing)
   */
  start(): void {
    log.debug('Starting job reporter');
    this.retryTimer = setInterval(() => {
      void this.processPendingReports();
    }, this.retryDelayMs);
  }

  /**
   * Stop the reporter
   */
  stop(): void {
    log.debug('Stopping job reporter');
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Report job started
   */
  async reportStarted(jobId: string): Promise<void> {
    log.info({ jobId }, 'Reporting job started');

    try {
      await this.apiClient.reportProgress(jobId, { progress: 0, message: 'Job started' });
    } catch (error) {
      log.error({ error, jobId }, 'Failed to report job started');
      this.queueReport({ jobId, type: 'started', data: null, attempts: 0, lastAttempt: null });
    }
  }

  /**
   * Report job progress
   */
  async reportProgress(jobId: string, percent: number, message?: string): Promise<void> {
    log.debug({ jobId, percent, message }, 'Reporting job progress');

    try {
      await this.apiClient.reportProgress(jobId, { progress: percent, message });
    } catch (error) {
      log.error({ error, jobId }, 'Failed to report job progress');
      // Progress updates are not critical, don't queue for retry
    }
  }

  /**
   * Report job completed
   */
  async reportCompleted(jobId: string, data: JobCompletionData): Promise<void> {
    log.info(
      { jobId, exitCode: data.exitCode, duration: data.duration },
      'Reporting job completed'
    );

    try {
      await this.apiClient.reportComplete(jobId, {
        exitCode: data.exitCode,
        duration: data.duration,
        output: this.truncateOutput(data.output),
        metrics: {
          peakMemory: data.peakMemory,
          avgGpuUtilization: data.avgCpu,
        },
      });
    } catch (error) {
      log.error({ error, jobId }, 'Failed to report job completed');
      this.queueReport({ jobId, type: 'completed', data, attempts: 0, lastAttempt: null });
    }
  }

  /**
   * Report job failed
   */
  async reportFailed(jobId: string, data: JobFailureData): Promise<void> {
    log.info(
      { jobId, exitCode: data.exitCode, retryable: data.retryable },
      'Reporting job failed'
    );

    try {
      await this.apiClient.reportFailure(jobId, {
        exitCode: data.exitCode,
        error: data.error,
        logs: this.truncateOutput(data.output),
        retryable: data.retryable,
      });
    } catch (error) {
      log.error({ error, jobId }, 'Failed to report job failure');
      this.queueReport({ jobId, type: 'failed', data, attempts: 0, lastAttempt: null });
    }
  }

  /**
   * Queue a report for retry
   */
  private queueReport(report: PendingReport): void {
    // Check for duplicate
    const existing = this.pendingReports.findIndex(
      r => r.jobId === report.jobId && r.type === report.type
    );
    if (existing !== -1) {
      // Update existing report
      this.pendingReports[existing] = report;
    } else {
      this.pendingReports.push(report);
    }

    log.debug({ jobId: report.jobId, type: report.type }, 'Report queued for retry');
  }

  /**
   * Process pending reports
   */
  private async processPendingReports(): Promise<void> {
    if (this.pendingReports.length === 0) {
      return;
    }

    log.debug({ count: this.pendingReports.length }, 'Processing pending reports');

    const reports = [...this.pendingReports];
    this.pendingReports = [];

    for (const report of reports) {
      if (report.attempts >= this.maxRetries) {
        log.error(
          { jobId: report.jobId, type: report.type, attempts: report.attempts },
          'Max retries reached, dropping report'
        );
        continue;
      }

      try {
        switch (report.type) {
          case 'started':
            await this.apiClient.reportProgress(report.jobId, { progress: 0, message: 'Job started' });
            break;
          case 'completed':
            const completedData = report.data as JobCompletionData;
            await this.apiClient.reportComplete(report.jobId, {
              exitCode: completedData.exitCode,
              duration: completedData.duration,
              output: this.truncateOutput(completedData.output),
              metrics: {
                peakMemory: completedData.peakMemory,
                avgGpuUtilization: completedData.avgCpu,
              },
            });
            break;
          case 'failed':
            const failedData = report.data as JobFailureData;
            await this.apiClient.reportFailure(report.jobId, {
              exitCode: failedData.exitCode,
              error: failedData.error,
              logs: this.truncateOutput(failedData.output),
              retryable: failedData.retryable,
            });
            break;
        }

        log.info({ jobId: report.jobId, type: report.type }, 'Retry successful');
      } catch (error) {
        log.warn(
          { error, jobId: report.jobId, type: report.type, attempt: report.attempts + 1 },
          'Retry failed'
        );
        report.attempts++;
        report.lastAttempt = new Date();
        this.pendingReports.push(report);
      }
    }
  }

  /**
   * Truncate output to reasonable size
   */
  private truncateOutput(output: string, maxLength: number = 100000): string {
    if (output.length <= maxLength) {
      return output;
    }

    const truncated = output.slice(-maxLength);
    const firstNewline = truncated.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 1000) {
      // Start from a line boundary if possible
      return `[truncated]\n${truncated.slice(firstNewline + 1)}`;
    }
    return `[truncated]\n${truncated}`;
  }

  /**
   * Get pending report count
   */
  getPendingCount(): number {
    return this.pendingReports.length;
  }

  /**
   * Check if there are pending reports
   */
  hasPending(): boolean {
    return this.pendingReports.length > 0;
  }
}
