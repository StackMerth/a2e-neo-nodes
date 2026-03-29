import { EventEmitter } from 'events';
import type { Job } from '../api/types.js';
import { jobLogger } from '../utils/logger.js';

const log = jobLogger();

/**
 * Job Queue Entry
 */
export interface QueuedJob {
  job: Job;
  addedAt: Date;
  priority: number;
}

/**
 * Local Job Queue - Manages jobs waiting to be executed
 */
export class JobQueue extends EventEmitter {
  private queue: QueuedJob[] = [];
  private readonly maxSize: number;
  private processing: boolean = false;

  constructor(maxSize: number = 10) {
    super();
    this.maxSize = maxSize;
  }

  /**
   * Add a job to the queue
   */
  enqueue(job: Job, priority: number = 0): boolean {
    if (this.queue.length >= this.maxSize) {
      log.warn({ jobId: job.id, queueSize: this.queue.length }, 'Queue full, rejecting job');
      return false;
    }

    // Check for duplicate
    if (this.queue.some(entry => entry.job.id === job.id)) {
      log.warn({ jobId: job.id }, 'Job already in queue');
      return false;
    }

    const entry: QueuedJob = {
      job,
      addedAt: new Date(),
      priority,
    };

    this.queue.push(entry);
    this.queue.sort((a, b) => b.priority - a.priority);

    log.info({ jobId: job.id, queueSize: this.queue.length }, 'Job added to queue');
    this.emit('jobEnqueued', job);

    return true;
  }

  /**
   * Get the next job from the queue
   */
  dequeue(): Job | null {
    const entry = this.queue.shift();
    if (entry) {
      log.debug({ jobId: entry.job.id, queueSize: this.queue.length }, 'Job dequeued');
      return entry.job;
    }
    return null;
  }

  /**
   * Peek at the next job without removing it
   */
  peek(): Job | null {
    return this.queue[0]?.job ?? null;
  }

  /**
   * Check if a specific job is in the queue
   */
  has(jobId: string): boolean {
    return this.queue.some(entry => entry.job.id === jobId);
  }

  /**
   * Remove a specific job from the queue
   */
  remove(jobId: string): boolean {
    const index = this.queue.findIndex(entry => entry.job.id === jobId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      log.info({ jobId, queueSize: this.queue.length }, 'Job removed from queue');
      return true;
    }
    return false;
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Check if queue is full
   */
  isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    const count = this.queue.length;
    this.queue = [];
    log.info({ clearedCount: count }, 'Queue cleared');
  }

  /**
   * Get all queued jobs
   */
  getAll(): Job[] {
    return this.queue.map(entry => entry.job);
  }

  /**
   * Set processing state
   */
  setProcessing(processing: boolean): void {
    this.processing = processing;
  }

  /**
   * Check if currently processing
   */
  isProcessing(): boolean {
    return this.processing;
  }
}
