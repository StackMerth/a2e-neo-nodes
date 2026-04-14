import * as fs from 'fs';
import * as path from 'path';
import { recoveryLogger } from '../utils/logger.js';

const log = recoveryLogger();

/**
 * Checkpoint data for a running job
 */
export interface JobCheckpoint {
  jobId: string;
  containerId: string;
  timestamp: string;
  progress: number;
  stage: string;
  outputLines: number;
  metrics: {
    peakMemory?: number;
    avgCpu?: number;
    elapsedSeconds: number;
  };
}

/**
 * Checkpoint Manager - Periodically saves job state for recovery of long-running jobs
 */
export class CheckpointManager {
  private readonly checkpointDir: string;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private readonly intervalMs: number;

  constructor(checkpointDir: string, intervalMs: number = 30000) {
    this.checkpointDir = checkpointDir;
    this.intervalMs = intervalMs;

    // Ensure checkpoint directory exists
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Start periodic checkpointing for a job
   */
  startCheckpointing(jobId: string, getCheckpointData: () => JobCheckpoint): void {
    // Save an initial checkpoint
    this.saveCheckpoint(getCheckpointData());

    // Schedule periodic saves
    const timer = setInterval(() => {
      try {
        this.saveCheckpoint(getCheckpointData());
      } catch (err) {
        log.warn({ jobId, error: (err as Error).message }, 'Failed to save checkpoint');
      }
    }, this.intervalMs);

    this.timers.set(jobId, timer);
    log.info({ jobId, intervalMs: this.intervalMs }, 'Started checkpointing');
  }

  /**
   * Stop checkpointing for a job and clean up the checkpoint file
   */
  stopCheckpointing(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(jobId);
    }

    this.removeCheckpoint(jobId);
    log.debug({ jobId }, 'Stopped checkpointing');
  }

  /**
   * Save a checkpoint to disk
   */
  private saveCheckpoint(checkpoint: JobCheckpoint): void {
    const filePath = this.getCheckpointPath(checkpoint.jobId);
    const tempPath = `${filePath}.tmp`;

    const content = JSON.stringify(checkpoint, null, 2);
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);

    log.debug(
      { jobId: checkpoint.jobId, progress: checkpoint.progress },
      'Checkpoint saved'
    );
  }

  /**
   * Load a checkpoint from disk
   */
  loadCheckpoint(jobId: string): JobCheckpoint | null {
    const filePath = this.getCheckpointPath(jobId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const checkpoint = JSON.parse(content) as JobCheckpoint;
      log.info({ jobId, progress: checkpoint.progress }, 'Loaded checkpoint');
      return checkpoint;
    } catch (err) {
      log.warn({ jobId, error: (err as Error).message }, 'Failed to load checkpoint');
      return null;
    }
  }

  /**
   * List all available checkpoints (for recovery on restart)
   */
  listCheckpoints(): JobCheckpoint[] {
    const checkpoints: JobCheckpoint[] = [];

    if (!fs.existsSync(this.checkpointDir)) {
      return checkpoints;
    }

    const files = fs.readdirSync(this.checkpointDir).filter(f => f.endsWith('.checkpoint.json'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.checkpointDir, file), 'utf-8');
        checkpoints.push(JSON.parse(content) as JobCheckpoint);
      } catch {
        log.warn({ file }, 'Skipping corrupt checkpoint file');
      }
    }

    return checkpoints;
  }

  /**
   * Remove a checkpoint file
   */
  private removeCheckpoint(jobId: string): void {
    const filePath = this.getCheckpointPath(jobId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      log.warn({ jobId, error: (err as Error).message }, 'Failed to remove checkpoint');
    }
  }

  /**
   * Clean up all checkpoint files
   */
  cleanup(): void {
    for (const [jobId, timer] of this.timers) {
      clearInterval(timer);
      this.removeCheckpoint(jobId);
    }
    this.timers.clear();
  }

  /**
   * Get the file path for a checkpoint
   */
  private getCheckpointPath(jobId: string): string {
    const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.checkpointDir, `${safeId}.checkpoint.json`);
  }
}
