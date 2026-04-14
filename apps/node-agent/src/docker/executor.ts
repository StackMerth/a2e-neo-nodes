import type Docker from 'dockerode';
import { EventEmitter } from 'events';
import { getDockerClient } from './client.js';
import type { DockerConfig, SecurityConfig } from '../config.js';
import type { Job } from '../api/types.js';
import { ContainerSandbox } from '../security/sandbox.js';
import { dockerLogger } from '../utils/logger.js';

const log = dockerLogger();

/**
 * Container Execution Options
 */
export interface ContainerExecutionOptions {
  job: Job;
  gpuDevices?: string; // e.g., "0", "0,1", "all"
  onLog?: (stream: 'stdout' | 'stderr', data: string) => void;
  onStats?: (stats: ContainerStats) => void;
}

/**
 * Container Stats
 */
export interface ContainerStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  blockRead: number;
  blockWrite: number;
}

/**
 * Container Execution Result
 */
export interface ContainerExecutionResult {
  containerId: string;
  exitCode: number;
  duration: number;
  output: string;
  error?: string;
  stats?: {
    peakMemory: number;
    avgCpuPercent: number;
  };
}

/**
 * Container Executor - Handles container lifecycle
 */
export class ContainerExecutor extends EventEmitter {
  private readonly dockerConfig: DockerConfig;
  private readonly sandbox: ContainerSandbox;
  private activeContainers: Map<string, Docker.Container> = new Map();

  constructor(dockerConfig: DockerConfig, _securityConfig: SecurityConfig) {
    super();
    this.dockerConfig = dockerConfig;
    this.sandbox = new ContainerSandbox('standard');
  }

  /**
   * Create container configuration
   */
  private createContainerConfig(options: ContainerExecutionOptions): Docker.ContainerCreateOptions {
    const { job, gpuDevices = 'all' } = options;

    // Build environment variables
    const env: string[] = [];
    if (job.env) {
      for (const [key, value] of Object.entries(job.env)) {
        env.push(`${key}=${value}`);
      }
    }

    // GPU configuration
    env.push(`NVIDIA_VISIBLE_DEVICES=${gpuDevices}`);

    // Build volume mounts
    const binds: string[] = [];
    if (job.volumes) {
      for (const vol of job.volumes) {
        const mode = vol.readOnly ? 'ro' : 'rw';
        binds.push(`${vol.hostPath}:${vol.containerPath}:${mode}`);
      }
    }

    // Host config — base settings
    let hostConfig: Docker.HostConfig = {
      Runtime: this.dockerConfig.gpuRuntime,
      AutoRemove: false, // We handle cleanup ourselves
      Binds: binds.length > 0 ? binds : undefined,
    };

    // Resource limits
    if (job.resources?.memory) {
      const memoryBytes = this.parseMemory(job.resources.memory);
      hostConfig.Memory = memoryBytes;
      hostConfig.MemorySwap = memoryBytes; // Disable swap
    }

    if (job.resources?.cpus) {
      hostConfig.NanoCpus = job.resources.cpus * 1e9;
    }

    // Apply sandbox security profile (capabilities, rootfs, tmpfs, ulimits, pids, network)
    hostConfig = this.sandbox.applyToHostConfig(hostConfig);

    let config: Docker.ContainerCreateOptions = {
      Image: job.image,
      Cmd: job.command,
      Entrypoint: job.entrypoint,
      Env: env,
      HostConfig: hostConfig,
      Labels: {
        'a2e.job.id': job.id,
        'a2e.managed': 'true',
      },
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: false,
    };

    // Apply sandbox user config (run as non-root if profile specifies)
    config = this.sandbox.applyUserConfig(config);

    // Validate the final config for security issues
    const validation = this.sandbox.validateConfig(config);
    if (!validation.valid) {
      log.warn({ issues: validation.issues, jobId: job.id }, 'Container config has security issues');
    }

    return config;
  }

  /**
   * Parse memory string to bytes
   */
  private parseMemory(memory: string): number {
    const match = memory.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|kb|mb|gb)?$/i);
    if (!match || !match[1]) {
      throw new Error(`Invalid memory format: ${memory}`);
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] ?? 'b').toLowerCase();

    const multipliers: Record<string, number> = {
      b: 1,
      k: 1024,
      kb: 1024,
      m: 1024 * 1024,
      mb: 1024 * 1024,
      g: 1024 * 1024 * 1024,
      gb: 1024 * 1024 * 1024,
    };

    return Math.floor(value * (multipliers[unit] ?? 1));
  }

  /**
   * Execute a job in a container
   */
  async execute(options: ContainerExecutionOptions): Promise<ContainerExecutionResult> {
    const { job, onLog, onStats } = options;
    const client = getDockerClient();
    const startTime = Date.now();
    let container: Docker.Container | null = null;
    let output = '';
    let peakMemory = 0;
    let cpuSamples: number[] = [];

    try {
      // Create container
      const config = this.createContainerConfig(options);
      log.info({ jobId: job.id, image: job.image }, 'Creating container');
      container = await client.createContainer(config);
      const containerId = container.id;
      this.activeContainers.set(job.id, container);

      this.emit('containerCreated', { jobId: job.id, containerId });

      // Attach to streams before starting
      const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });

      // Handle output
      stream.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        output += text;

        // Limit output size
        if (output.length > 1024 * 1024) { // 1MB
          output = output.slice(-1024 * 1024);
        }

        if (onLog) {
          // Demux stdout/stderr (Docker multiplexes them)
          onLog('stdout', text);
        }
      });

      // Start container
      log.info({ jobId: job.id, containerId }, 'Starting container');
      await container.start();

      this.emit('containerStarted', { jobId: job.id, containerId });

      // Start stats collection
      let statsStream: NodeJS.ReadableStream | null = null;
      if (onStats) {
        statsStream = await container.stats({ stream: true });
        statsStream.on('data', (data: Buffer) => {
          try {
            const stats = JSON.parse(data.toString()) as Docker.ContainerStats;
            const parsed = this.parseStats(stats);

            peakMemory = Math.max(peakMemory, parsed.memoryUsed);
            cpuSamples.push(parsed.cpuPercent);

            onStats(parsed);
          } catch {
            // Ignore parse errors
          }
        });
      }

      // Wait for completion with timeout
      const timeout = job.timeout * 1000;
      const waitPromise = container.wait();

      const result = await Promise.race([
        waitPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Container execution timed out')), timeout);
        }),
      ]);

      // Stop stats stream
      if (statsStream && 'destroy' in statsStream) {
        (statsStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
      }

      const duration = Math.floor((Date.now() - startTime) / 1000);
      const exitCode = result.StatusCode;

      log.info(
        { jobId: job.id, containerId, exitCode, duration },
        'Container execution completed'
      );

      this.emit('containerCompleted', { jobId: job.id, containerId, exitCode });

      // Calculate average CPU
      const avgCpuPercent = cpuSamples.length > 0
        ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length
        : 0;

      return {
        containerId,
        exitCode,
        duration,
        output,
        stats: {
          peakMemory,
          avgCpuPercent,
        },
      };
    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      log.error({ error, jobId: job.id }, 'Container execution failed');

      // Try to get container ID for cleanup
      const containerId = container?.id ?? 'unknown';

      this.emit('containerFailed', { jobId: job.id, containerId, error: errorMessage });

      // Try to stop the container if it's still running
      if (container) {
        try {
          await this.stop(job.id, 10);
        } catch {
          // Ignore stop errors during cleanup
        }
      }

      return {
        containerId,
        exitCode: -1,
        duration,
        output,
        error: errorMessage,
      };
    } finally {
      this.activeContainers.delete(job.id);
    }
  }

  /**
   * Parse Docker stats
   */
  private parseStats(stats: Docker.ContainerStats): ContainerStats {
    // CPU calculation
    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
                     (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) -
                        (stats.precpu_stats?.system_cpu_usage ?? 0);
    const cpuCount = stats.cpu_stats?.online_cpus ?? 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    // Memory
    const memoryUsed = stats.memory_stats?.usage ?? 0;
    const memoryLimit = stats.memory_stats?.limit ?? 0;
    const memoryPercent = memoryLimit > 0 ? (memoryUsed / memoryLimit) * 100 : 0;

    // Network
    let networkRx = 0;
    let networkTx = 0;
    if (stats.networks) {
      for (const net of Object.values(stats.networks)) {
        networkRx += net.rx_bytes ?? 0;
        networkTx += net.tx_bytes ?? 0;
      }
    }

    // Block I/O
    let blockRead = 0;
    let blockWrite = 0;
    if (stats.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        if (entry.op === 'read') {
          blockRead += entry.value;
        } else if (entry.op === 'write') {
          blockWrite += entry.value;
        }
      }
    }

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsed,
      memoryLimit,
      memoryPercent: Math.round(memoryPercent * 100) / 100,
      networkRx,
      networkTx,
      blockRead,
      blockWrite,
    };
  }

  /**
   * Stop a container
   */
  async stop(jobId: string, timeoutSeconds: number = 30): Promise<void> {
    const container = this.activeContainers.get(jobId);
    if (!container) {
      log.warn({ jobId }, 'No active container found for job');
      return;
    }

    log.info({ jobId, timeout: timeoutSeconds }, 'Stopping container');

    try {
      // Try graceful stop first
      await container.stop({ t: timeoutSeconds });
    } catch (error) {
      // If stop fails, try kill
      log.warn({ jobId, error }, 'Graceful stop failed, killing container');
      try {
        await container.kill();
      } catch {
        // Container may already be stopped
      }
    }

    this.activeContainers.delete(jobId);
  }

  /**
   * Remove a container
   */
  async remove(containerId: string, force: boolean = false): Promise<void> {
    const client = getDockerClient();
    const container = client.getContainer(containerId);

    try {
      await container.remove({ force, v: true }); // Also remove volumes
      log.info({ containerId }, 'Container removed');
    } catch (error) {
      log.error({ error, containerId }, 'Failed to remove container');
      throw error;
    }
  }

  /**
   * Get logs from a container
   */
  async getLogs(containerId: string, tail: number = 1000): Promise<string> {
    const client = getDockerClient();
    const container = client.getContainer(containerId);

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    });

    return logs.toString('utf-8');
  }

  /**
   * Check if a job is currently running
   */
  isRunning(jobId: string): boolean {
    return this.activeContainers.has(jobId);
  }

  /**
   * Get all active job IDs
   */
  getActiveJobs(): string[] {
    return Array.from(this.activeContainers.keys());
  }

  /**
   * Stop all active containers
   */
  async stopAll(timeoutSeconds: number = 10): Promise<void> {
    const jobs = this.getActiveJobs();
    log.info({ count: jobs.length }, 'Stopping all active containers');

    await Promise.all(
      jobs.map(jobId => this.stop(jobId, timeoutSeconds).catch(() => {}))
    );
  }
}
