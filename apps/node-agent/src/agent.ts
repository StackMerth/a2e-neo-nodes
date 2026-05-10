import { EventEmitter } from 'events';
import type { Config } from './config.js';
import { setNodeId } from './config.js';
import { agentLogger } from './utils/logger.js';
import { getApiClient } from './api/client.js';
import type { NodeSpecs, GpuMetrics, SystemMetrics } from './api/types.js';
import { GpuDetector } from './gpu/detector.js';
import { GpuMetricsCollector } from './gpu/metrics.js';
import { GpuHealthMonitor } from './gpu/health.js';
import { HeartbeatService } from './heartbeat/sender.js';
import { HealthServer } from './health/server.js';
import { StateManager } from './recovery/state.js';
import { initDockerClient, type DockerClient } from './docker/client.js';
import { ImagePrewarmService } from './docker/image-prewarm.js';
import { JobRecoveryManager } from './recovery/job-recovery.js';
import { ConnectionRecoveryManager } from './recovery/reconnect.js';
import { JobReporter } from './jobs/reporter.js';
import { JobQueue } from './jobs/queue.js';
import { JobExecutor } from './jobs/executor.js';
import { JobPoller } from './jobs/poller.js';
import * as os from 'os';
import * as fs from 'fs';

const log = agentLogger();

/**
 * Agent States
 */
export type AgentState =
  | 'INITIALIZING'
  | 'REGISTERING'
  | 'ONLINE'
  | 'BUSY'
  | 'MAINTENANCE'
  | 'OFFLINE'
  | 'STOPPING'
  | 'ERROR';

/**
 * Agent Events
 */
export interface AgentEvents {
  stateChange: (newState: AgentState, oldState: AgentState) => void;
  registered: (nodeId: string) => void;
  heartbeatSent: () => void;
  heartbeatFailed: (error: Error) => void;
  jobReceived: (jobId: string) => void;
  jobStarted: (jobId: string) => void;
  jobCompleted: (jobId: string) => void;
  jobFailed: (jobId: string, error: Error) => void;
  error: (error: Error) => void;
}

/**
 * Agent Version
 */
const AGENT_VERSION = '1.0.0';

/**
 * A²E Node Agent
 */
export class Agent extends EventEmitter {
  private readonly config: Config;
  private state: AgentState = 'INITIALIZING';
  private nodeId: string | null = null;
  private gpuDetector: GpuDetector | null = null;
  private gpuMetrics: GpuMetricsCollector | null = null;
  private gpuHealthMonitor: GpuHealthMonitor | null = null;
  private heartbeat: HeartbeatService | null = null;
  private healthServer: HealthServer | null = null;
  private stateManager: StateManager | null = null;
  private dockerClient: DockerClient | null = null;
  private reporter: JobReporter | null = null;
  private jobQueue: JobQueue | null = null;
  private jobExecutor: JobExecutor | null = null;
  private jobPoller: JobPoller | null = null;
  private connectionRecovery: ConnectionRecoveryManager | null = null;
  private currentJobId: string | null = null;
  private startTime: number = 0;
  private imagePrewarm: ImagePrewarmService | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  /**
   * Get current state
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Get node ID
   */
  getNodeId(): string | null {
    return this.nodeId;
  }

  /**
   * Get current job ID
   */
  getCurrentJobId(): string | null {
    return this.currentJobId;
  }

  /**
   * Get job queue size
   */
  getQueueSize(): number {
    return this.jobQueue?.size() ?? 0;
  }

  /**
   * Set current job ID (called by executor when a job starts)
   */
  setCurrentJobId(jobId: string | null): void {
    this.currentJobId = jobId;
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    if (this.startTime === 0) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Set agent state
   */
  private setState(newState: AgentState): void {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }

    log.info({ oldState, newState }, 'Agent state changed');
    this.state = newState;
    this.emit('stateChange', newState, oldState);
  }

  /**
   * Initialize agent components
   */
  async initialize(): Promise<void> {
    log.info('Initializing agent');
    this.setState('INITIALIZING');

    // Initialize state manager
    this.stateManager = new StateManager(this.config.recovery.stateFile);
    await this.stateManager.load();

    // Check for existing registration
    const savedState = this.stateManager.getState();
    if (savedState?.nodeId) {
      this.nodeId = savedState.nodeId;
      log.info({ nodeId: this.nodeId }, 'Loaded existing node ID from state');
    }

    // Initialize GPU detector
    this.gpuDetector = new GpuDetector(this.config.gpu);
    await this.gpuDetector.detect();

    // Initialize GPU metrics collector (pass config for mock mode support)
    this.gpuMetrics = new GpuMetricsCollector(this.config.gpu);

    // Initialize Docker client (skip in mock GPU mode)
    if (!this.config.gpu.mockGpu) {
      this.dockerClient = await initDockerClient(this.config.docker);
      log.info('Docker client initialized');
    } else {
      log.warn('Mock GPU mode — Docker client initialization skipped');
    }

    log.info('Agent initialized');
  }

  /**
   * Register with A²E server
   */
  private async register(): Promise<void> {
    this.setState('REGISTERING');
    log.info('Registering with A²E server');

    const api = getApiClient();

    // Check if already registered (from saved state or config)
    const existingNodeId = this.nodeId || this.config.agent.nodeId;
    if (existingNodeId) {
      this.nodeId = existingNodeId;
      log.info({ nodeId: this.nodeId }, 'Using existing node ID');
      api.setNodeId(this.nodeId);
      return;
    }

    // Collect node specifications
    const specs = await this.collectNodeSpecs();

    // Register with server
    const response = await api.registerNode({
      name: this.config.agent.name,
      specs,
    });

    this.nodeId = response.nodeId;
    api.setNodeId(this.nodeId);
    setNodeId(this.nodeId);

    // Save to state
    if (this.stateManager) {
      this.stateManager.setState({
        ...this.stateManager.getState(),
        nodeId: this.nodeId,
        registeredAt: new Date().toISOString(),
      });
      await this.stateManager.save();
    }

    log.info({ nodeId: this.nodeId }, 'Successfully registered with A²E');
    this.emit('registered', this.nodeId);
  }

  /**
   * Collect node specifications for registration
   */
  private async collectNodeSpecs(): Promise<NodeSpecs> {
    if (!this.gpuDetector) {
      throw new Error('GPU detector not initialized');
    }

    const gpuInfo = this.gpuDetector.getGpuInfo();
    if (!gpuInfo) {
      throw new Error('No GPU detected');
    }

    // Get Docker version
    let dockerVersion = 'unknown';
    try {
      const { execSync } = await import('child_process');
      dockerVersion = execSync('docker --version', { encoding: 'utf-8' }).trim();
    } catch {
      log.warn('Could not get Docker version');
    }

    return {
      gpuModel: gpuInfo.model,
      gpuTier: gpuInfo.tier,
      gpuCount: gpuInfo.count,
      gpuVram: gpuInfo.vram,
      gpuDriver: gpuInfo.driver,
      cudaVersion: gpuInfo.cudaVersion,
      hostname: os.hostname(),
      os: os.platform(),
      osVersion: os.release(),
      totalMemory: os.totalmem(),
      totalCpus: os.cpus().length,
      dockerVersion,
      agentVersion: AGENT_VERSION,
    };
  }

  /**
   * Collect current GPU metrics
   */
  async collectGpuMetrics(): Promise<GpuMetrics> {
    if (!this.gpuMetrics) {
      throw new Error('GPU metrics collector not initialized');
    }

    return this.gpuMetrics.collect();
  }

  /**
   * Collect current system metrics
   */
  collectSystemMetrics(): SystemMetrics {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();

    // Calculate CPU usage (average across all cores)
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }
    const cpuUsage = 100 - (totalIdle / totalTick) * 100;

    // Get disk usage for root partition
    let diskUsed = 0;
    let diskTotal = 0;
    try {
      const stats = fs.statfsSync('/');
      diskTotal = stats.blocks * stats.bsize;
      diskUsed = (stats.blocks - stats.bfree) * stats.bsize;
    } catch {
      log.warn('Could not get disk stats');
    }

    return {
      cpuUsage: Math.round(cpuUsage * 100) / 100,
      memoryUsed: totalMem - freeMem,
      memoryTotal: totalMem,
      diskUsed,
      diskTotal,
      uptime: this.getUptime(),
    };
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    log.info('Starting agent');
    this.startTime = Date.now();

    try {
      // Initialize components
      await this.initialize();

      // Register with server
      await this.register();

      // Start job reporter (retry queue for failed status reports)
      this.reporter = new JobReporter(getApiClient());
      this.reporter.start();
      log.info('Job reporter started');

      // Initialize job queue
      this.jobQueue = new JobQueue(this.config.docker.maxConcurrentJobs * 2);
      log.info('Job queue initialized');

      // Run job recovery check (handle incomplete jobs from previous run)
      if (!this.config.gpu.mockGpu && this.stateManager && this.reporter) {
        const recoveryManager = new JobRecoveryManager(this.stateManager, this.reporter);
        const recoveryResult = await recoveryManager.recover();
        if (recoveryResult.incompleteJobFound) {
          log.info(
            { jobId: recoveryResult.jobId, action: recoveryResult.action },
            'Recovery completed for incomplete job'
          );
        } else {
          log.info('No incomplete jobs found during recovery');
        }
      }

      // Start job executor (processes jobs from the queue)
      if (this.jobQueue && this.reporter) {
        this.jobExecutor = new JobExecutor(
          this.jobQueue,
          this.reporter,
          this.config.docker,
          this.config.security,
        );

        // Wire executor events to agent state transitions + state persistence
        this.jobExecutor.on('jobStarted', (job: { id: string; image: string }) => {
          this.setCurrentJobId(job.id);
          this.setState('BUSY');
          // Persist job state for crash recovery
          if (this.stateManager) {
            this.stateManager.setCurrentJob({
              jobId: job.id,
              containerId: '', // Updated when container is created
              startedAt: new Date().toISOString(),
              image: job.image,
            });
            void this.stateManager.save();
          }
          this.emit('jobStarted', job.id);
          log.info({ jobId: job.id }, 'Job started — agent BUSY');
        });

        this.jobExecutor.on('containerCreated', ({ jobId, containerId }: { jobId: string; containerId: string }) => {
          // Update state with actual container ID for recovery
          if (this.stateManager) {
            const currentJob = this.stateManager.getIncompleteJob();
            if (currentJob && currentJob.jobId === jobId) {
              this.stateManager.setCurrentJob({ ...currentJob, containerId });
              void this.stateManager.save();
            }
          }
        });

        this.jobExecutor.on('jobCompleted', ({ job }: { job: { id: string } }) => {
          this.setCurrentJobId(null);
          if (this.stateManager) {
            this.stateManager.clearCurrentJob();
            void this.stateManager.save();
          }
          if (this.state !== 'STOPPING') {
            this.setState('ONLINE');
          }
          this.emit('jobCompleted', job.id);
          log.info({ jobId: job.id }, 'Job completed — agent ONLINE');
        });

        this.jobExecutor.on('jobFailed', ({ job }: { job: { id: string } }) => {
          this.setCurrentJobId(null);
          if (this.stateManager) {
            this.stateManager.clearCurrentJob();
            void this.stateManager.save();
          }
          if (this.state !== 'STOPPING') {
            this.setState('ONLINE');
          }
          this.emit('jobFailed', job.id);
          log.warn({ jobId: job.id }, 'Job failed — agent ONLINE');
        });

        this.jobExecutor.start();
        log.info('Job executor started');
      }

      // Start job poller (polls server for assigned jobs)
      if (this.nodeId && this.jobQueue) {
        const gpuInfo = this.gpuDetector?.getGpuInfo();
        this.jobPoller = new JobPoller(getApiClient(), this.jobQueue, {
          pollIntervalMs: this.config.agent.jobPollInterval * 1000,
          agentVersion: AGENT_VERSION,
        });
        this.jobPoller.start(this.nodeId, {
          gpuTier: gpuInfo?.tier ?? 'OTHER',
          gpuCount: gpuInfo?.count ?? 1,
          availableVram: gpuInfo?.vram ?? 0,
        });
        log.info('Job poller started');
      }

      // Start connection recovery monitor
      this.connectionRecovery = new ConnectionRecoveryManager(getApiClient(), {
        maxRetries: this.config.recovery.maxReconnectAttempts,
        initialDelayMs: this.config.recovery.reconnectDelay,
      });
      this.connectionRecovery.on('disconnected', () => {
        log.warn('Connection to A²E server lost — queuing updates');
      });
      this.connectionRecovery.on('connected', () => {
        log.info('Connection to A²E server restored');
      });
      this.connectionRecovery.on('maxRetriesReached', () => {
        log.error('Max reconnection attempts reached');
        this.setState('ERROR');
      });
      this.connectionRecovery.start();
      log.info('Connection recovery monitor started');

      // Start GPU health monitor
      this.gpuHealthMonitor = new GpuHealthMonitor(30, this.config.gpu);
      this.gpuHealthMonitor.on('issue', (issue: { type: string; severity: string; message: string }) => {
        if (issue.severity === 'CRITICAL') {
          log.error({ issue }, 'Critical GPU health issue detected');
        } else {
          log.warn({ issue }, 'GPU health warning');
        }
      });
      this.gpuHealthMonitor.start();
      log.info('GPU health monitor started');

      // Start heartbeat service
      this.heartbeat = new HeartbeatService(this, this.config.agent.heartbeatInterval);
      this.heartbeat.start();

      // Start health check server
      this.healthServer = new HealthServer(this);
      this.healthServer.start();

      // Set state to online
      this.setState('ONLINE');

      // M2: image prewarm (only if Docker is available — no-op for mock GPU
      // or air-gapped runners). Pulls top-N popular template images during
      // idle time so buyer launches are warm.
      if (this.dockerClient) {
        this.imagePrewarm = new ImagePrewarmService(
          this.dockerClient,
          this.config,
          () => this.state === 'ONLINE' && this.currentJobId === null,
        );
        this.imagePrewarm.start();
      }

      log.info({ nodeId: this.nodeId }, 'Agent started successfully');
    } catch (error) {
      log.error({ error }, 'Failed to start agent');
      this.setState('ERROR');
      throw error;
    }
  }

  /**
   * Stop the agent gracefully
   */
  async stop(): Promise<void> {
    log.info('Stopping agent');
    this.setState('STOPPING');

    // 0. Stop image prewarm so an in-flight pull doesn't block shutdown.
    if (this.imagePrewarm) {
      this.imagePrewarm.stop();
    }

    // 1. Stop job poller first (no new jobs accepted)
    if (this.jobPoller) {
      this.jobPoller.stop();
      log.info('Job poller stopped');
    }

    // 2. Wait for current job to complete, then stop executor
    if (this.jobExecutor) {
      if (this.currentJobId) {
        const shutdownTimeout = 60000; // 60 seconds max wait
        log.info({ jobId: this.currentJobId, timeoutMs: shutdownTimeout }, 'Waiting for current job to complete');

        const waitStart = Date.now();
        while (this.currentJobId && (Date.now() - waitStart) < shutdownTimeout) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (this.currentJobId) {
          log.warn({ jobId: this.currentJobId }, 'Shutdown timeout reached, forcing job stop');
        } else {
          log.info('Current job completed before shutdown');
        }
      }
      await this.jobExecutor.stop();
      log.info('Job executor stopped');
    }

    // 3. Stop heartbeat
    if (this.heartbeat) {
      this.heartbeat.stop();
      log.info('Heartbeat stopped');
    }

    // 4. Stop connection recovery monitor
    if (this.connectionRecovery) {
      this.connectionRecovery.stop();
      log.info('Connection recovery monitor stopped');
    }

    // 5. Stop GPU health monitor
    if (this.gpuHealthMonitor) {
      this.gpuHealthMonitor.stop();
      log.info('GPU health monitor stopped');
    }

    // 6. Stop job reporter (flush pending reports)
    if (this.reporter) {
      this.reporter.stop();
      log.info('Job reporter stopped');
    }

    // 7. Stop health server
    if (this.healthServer) {
      await this.healthServer.stop();
      log.info('Health server stopped');
    }

    // 8. Save final state
    if (this.stateManager) {
      await this.stateManager.save();
      log.info('State saved');
    }

    log.info('Agent stopped');
  }

  /**
   * Restart the agent
   */
  async restart(): Promise<void> {
    log.info('Restarting agent');
    await this.stop();
    await this.start();
  }

  /**
   * Uninstall the agent completely
   * Removes all files created during provisioning and stops the service
   *
   * Strategy: Create a cleanup script and run it detached, then exit.
   * The cleanup script will wait for this process to exit, then remove everything.
   */
  async uninstall(): Promise<void> {
    log.info('Uninstalling agent...');
    this.setState('STOPPING');

    // Stop heartbeat first
    if (this.heartbeat) {
      this.heartbeat.stop();
    }

    const { spawn } = await import('child_process');

    try {
      // Create a cleanup script that will run after this process exits
      const cleanupScript = `#!/bin/bash
# Wait for the agent process to exit
sleep 2

# Disable the service first (prevent restart)
systemctl disable a2e-agent 2>/dev/null || true

# Stop the service
systemctl stop a2e-agent 2>/dev/null || true

# Remove systemd service file
rm -f /etc/systemd/system/a2e-agent.service
systemctl daemon-reload 2>/dev/null || true

# Remove agent directories
rm -rf /opt/a2e-agent
rm -rf /etc/a2e-agent
rm -rf /var/lib/a2e-agent
rm -rf /var/log/a2e-agent

# Remove symlink
rm -f /usr/local/bin/a2e-agent

# Remove this cleanup script
rm -f /tmp/a2e-uninstall.sh

echo "A2E Agent uninstalled successfully"
`;

      // Write the cleanup script
      fs.writeFileSync('/tmp/a2e-uninstall.sh', cleanupScript, { mode: 0o755 });
      log.info('Created cleanup script at /tmp/a2e-uninstall.sh');

      // Spawn the cleanup script as a detached process
      const child = spawn('/bin/bash', ['/tmp/a2e-uninstall.sh'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      log.info('Spawned cleanup process, exiting agent...');

      // Give the script a moment to start, then exit
      setTimeout(() => {
        process.exit(0);
      }, 500);
    } catch (error) {
      log.error({ error }, 'Failed to initiate uninstall');
      throw error;
    }
  }

  /**
   * Get agent status for display
   */
  getStatus(): {
    state: AgentState;
    nodeId: string | null;
    uptime: number;
    currentJob: string | null;
    gpuTier: string | null;
    dockerConnected: boolean;
  } {
    return {
      state: this.state,
      nodeId: this.nodeId,
      uptime: this.getUptime(),
      currentJob: this.currentJobId,
      gpuTier: this.gpuDetector?.getGpuInfo()?.tier ?? null,
      dockerConnected: this.dockerClient?.isConnected() ?? false,
    };
  }
}
