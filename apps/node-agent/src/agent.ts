import { EventEmitter } from 'events';
import type { Config } from './config.js';
import { setNodeId } from './config.js';
import { agentLogger } from './utils/logger.js';
import { getApiClient } from './api/client.js';
import type { NodeSpecs, GpuMetrics, SystemMetrics } from './api/types.js';
import { GpuDetector } from './gpu/detector.js';
import { GpuMetricsCollector } from './gpu/metrics.js';
import { HeartbeatService } from './heartbeat/sender.js';
import { StateManager } from './recovery/state.js';
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
  private heartbeat: HeartbeatService | null = null;
  private stateManager: StateManager | null = null;
  private currentJobId: string | null = null;
  private startTime: number = 0;

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

    log.info('Agent initialized');
  }

  /**
   * Register with A²E server
   */
  private async register(): Promise<void> {
    this.setState('REGISTERING');
    log.info('Registering with A²E server');

    const api = getApiClient();

    // Check if already registered
    if (this.nodeId && this.config.agent.nodeId) {
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

      // Start heartbeat service
      this.heartbeat = new HeartbeatService(this, this.config.agent.heartbeatInterval);
      this.heartbeat.start();

      // Set state to online
      this.setState('ONLINE');

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

    // Stop heartbeat
    if (this.heartbeat) {
      this.heartbeat.stop();
    }

    // Wait for current job to complete (with timeout)
    if (this.currentJobId) {
      log.info({ jobId: this.currentJobId }, 'Waiting for current job to complete');
      // TODO: Implement job completion wait with timeout
    }

    // Save state
    if (this.stateManager) {
      await this.stateManager.save();
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
  } {
    return {
      state: this.state,
      nodeId: this.nodeId,
      uptime: this.getUptime(),
      currentJob: this.currentJobId,
      gpuTier: this.gpuDetector?.getGpuInfo()?.tier ?? null,
    };
  }
}
