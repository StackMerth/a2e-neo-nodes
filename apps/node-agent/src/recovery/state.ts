import * as fs from 'fs';
import * as path from 'path';
import { recoveryLogger } from '../utils/logger.js';

const log = recoveryLogger();

/**
 * Persisted Agent State
 */
export interface AgentState {
  nodeId: string | null;
  registeredAt: string | null;
  lastHeartbeat: string | null;
  currentJob: {
    jobId: string;
    containerId: string;
    startedAt: string;
    image: string;
  } | null;
  pendingJobs: string[];
  completedJobIds: string[];
  version: number;
}

/**
 * Default empty state
 */
const DEFAULT_STATE: AgentState = {
  nodeId: null,
  registeredAt: null,
  lastHeartbeat: null,
  currentJob: null,
  pendingJobs: [],
  completedJobIds: [],
  version: 1,
};

/**
 * State Manager - Handles agent state persistence
 */
export class StateManager {
  private readonly stateFile: string;
  private state: AgentState = { ...DEFAULT_STATE };
  private dirty: boolean = false;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
  }

  /**
   * Load state from file
   */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(this.stateFile)) {
        log.info({ stateFile: this.stateFile }, 'No existing state file, starting fresh');
        this.state = { ...DEFAULT_STATE };
        return;
      }

      const content = fs.readFileSync(this.stateFile, 'utf-8');
      const parsed = JSON.parse(content) as Partial<AgentState>;

      // Validate and merge with defaults
      this.state = {
        ...DEFAULT_STATE,
        ...parsed,
      };

      log.info(
        { stateFile: this.stateFile, nodeId: this.state.nodeId },
        'Loaded state from file'
      );
    } catch (error) {
      log.warn({ error, stateFile: this.stateFile }, 'Failed to load state, using defaults');
      this.state = { ...DEFAULT_STATE };
    }
  }

  /**
   * Save state to file (atomic write)
   */
  async save(): Promise<void> {
    if (!this.dirty && fs.existsSync(this.stateFile)) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Update last heartbeat
      this.state.lastHeartbeat = new Date().toISOString();

      // Write to temp file first (atomic write)
      const tempFile = `${this.stateFile}.tmp`;
      const content = JSON.stringify(this.state, null, 2);

      fs.writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tempFile, this.stateFile);

      this.dirty = false;
      log.debug({ stateFile: this.stateFile }, 'Saved state to file');
    } catch (error) {
      log.error({ error, stateFile: this.stateFile }, 'Failed to save state');
      throw error;
    }
  }

  /**
   * Get current state
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Set state (marks as dirty)
   */
  setState(newState: Partial<AgentState>): void {
    this.state = { ...this.state, ...newState };
    this.dirty = true;
  }

  /**
   * Set node ID
   */
  setNodeId(nodeId: string): void {
    this.state.nodeId = nodeId;
    this.state.registeredAt = new Date().toISOString();
    this.dirty = true;
  }

  /**
   * Set current job
   */
  setCurrentJob(job: AgentState['currentJob']): void {
    this.state.currentJob = job;
    this.dirty = true;
  }

  /**
   * Clear current job
   */
  clearCurrentJob(): void {
    if (this.state.currentJob) {
      // Move to completed
      this.state.completedJobIds.push(this.state.currentJob.jobId);

      // Keep only last 100 completed job IDs
      if (this.state.completedJobIds.length > 100) {
        this.state.completedJobIds = this.state.completedJobIds.slice(-100);
      }
    }
    this.state.currentJob = null;
    this.dirty = true;
  }

  /**
   * Check if there's an incomplete job
   */
  hasIncompleteJob(): boolean {
    return this.state.currentJob !== null;
  }

  /**
   * Get incomplete job
   */
  getIncompleteJob(): AgentState['currentJob'] {
    return this.state.currentJob;
  }

  /**
   * Reset state to defaults
   */
  reset(): void {
    this.state = { ...DEFAULT_STATE };
    this.dirty = true;
  }

  /**
   * Delete state file
   */
  async delete(): Promise<void> {
    try {
      if (fs.existsSync(this.stateFile)) {
        fs.unlinkSync(this.stateFile);
        log.info({ stateFile: this.stateFile }, 'Deleted state file');
      }
    } catch (error) {
      log.error({ error }, 'Failed to delete state file');
    }
    this.state = { ...DEFAULT_STATE };
    this.dirty = false;
  }
}
