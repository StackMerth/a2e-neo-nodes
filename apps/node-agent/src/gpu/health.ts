import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { gpuLogger } from '../utils/logger.js';
import type { GpuMetrics } from '../api/types.js';
import type { GpuConfig } from '../config.js';

const log = gpuLogger();

/**
 * GPU Health Status
 */
export type GpuHealthStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

/**
 * GPU Health Issue
 */
export interface GpuHealthIssue {
  type: 'TEMPERATURE' | 'THROTTLING' | 'MEMORY' | 'ERROR' | 'POWER';
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  value?: number;
  threshold?: number;
  timestamp: Date;
}

/**
 * GPU Health Report
 */
export interface GpuHealthReport {
  status: GpuHealthStatus;
  issues: GpuHealthIssue[];
  metrics: GpuMetrics | null;
  lastCheck: Date;
}

/**
 * Temperature thresholds (Celsius)
 */
const TEMP_THRESHOLDS = {
  WARNING: 80,
  CRITICAL: 90,
};

/**
 * Memory utilization thresholds (%)
 */
const MEMORY_THRESHOLDS = {
  WARNING: 90,
  CRITICAL: 98,
};

/**
 * GPU utilization thresholds for throttling detection
 */
const THROTTLE_DETECTION = {
  EXPECTED_MIN_UTIL: 50, // If GPU should be busy but util is low
  TEMP_THROTTLE_THRESHOLD: 85, // Temperature at which throttling likely
};

/**
 * GPU Health Monitor - Monitors GPU health and emits alerts
 */
export class GpuHealthMonitor extends EventEmitter {
  private lastReport: GpuHealthReport | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private running: boolean = false;
  private readonly config?: GpuConfig;

  constructor(intervalSeconds: number = 30, config?: GpuConfig) {
    super();
    this.intervalMs = intervalSeconds * 1000;
    this.config = config;
  }

  /**
   * Generate mock metrics for testing
   */
  private generateMockMetrics(): GpuMetrics {
    const baseTemp = 45 + Math.random() * 15;
    const baseUtil = Math.random() * 10;
    const baseMem = 2000 + Math.random() * 1000;

    return {
      temperature: Math.round(baseTemp),
      utilizationGpu: Math.round(baseUtil),
      utilizationMemory: Math.round(baseUtil * 0.5),
      memoryUsed: Math.round(baseMem),
      memoryTotal: this.config?.mockVram ?? 81920,
      powerDraw: Math.round(80 + Math.random() * 20),
      fanSpeed: Math.round(30 + Math.random() * 10),
    };
  }

  /**
   * Start health monitoring
   */
  start(): void {
    if (this.running) {
      log.warn('Health monitor already running');
      return;
    }

    log.info({ intervalSeconds: this.intervalMs / 1000 }, 'Starting GPU health monitor');
    this.running = true;

    // Initial check
    void this.performHealthCheck();

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      void this.performHealthCheck();
    }, this.intervalMs);
  }

  /**
   * Stop health monitoring
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    log.info('Stopping GPU health monitor');
    this.running = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Perform a health check
   */
  async performHealthCheck(): Promise<GpuHealthReport> {
    const issues: GpuHealthIssue[] = [];
    let metrics: GpuMetrics | null = null;
    let status: GpuHealthStatus = 'HEALTHY';

    try {
      // Collect metrics
      metrics = await this.collectMetrics();

      // Check temperature
      if (metrics.temperature >= TEMP_THRESHOLDS.CRITICAL) {
        issues.push({
          type: 'TEMPERATURE',
          severity: 'CRITICAL',
          message: `GPU temperature critically high: ${metrics.temperature}°C`,
          value: metrics.temperature,
          threshold: TEMP_THRESHOLDS.CRITICAL,
          timestamp: new Date(),
        });
        status = 'CRITICAL';
      } else if (metrics.temperature >= TEMP_THRESHOLDS.WARNING) {
        issues.push({
          type: 'TEMPERATURE',
          severity: 'WARNING',
          message: `GPU temperature elevated: ${metrics.temperature}°C`,
          value: metrics.temperature,
          threshold: TEMP_THRESHOLDS.WARNING,
          timestamp: new Date(),
        });
        status = 'WARNING';
      }

      // Check memory utilization
      const memoryUtil = (metrics.memoryUsed / metrics.memoryTotal) * 100;
      if (memoryUtil >= MEMORY_THRESHOLDS.CRITICAL) {
        issues.push({
          type: 'MEMORY',
          severity: 'CRITICAL',
          message: `GPU memory nearly exhausted: ${memoryUtil.toFixed(1)}%`,
          value: memoryUtil,
          threshold: MEMORY_THRESHOLDS.CRITICAL,
          timestamp: new Date(),
        });
        status = 'CRITICAL';
      } else if (memoryUtil >= MEMORY_THRESHOLDS.WARNING) {
        issues.push({
          type: 'MEMORY',
          severity: 'WARNING',
          message: `GPU memory usage high: ${memoryUtil.toFixed(1)}%`,
          value: memoryUtil,
          threshold: MEMORY_THRESHOLDS.WARNING,
          timestamp: new Date(),
        });
        if (status !== 'CRITICAL') {
          status = 'WARNING';
        }
      }

      // Check for thermal throttling
      const throttleIssue = await this.detectThrottling(metrics);
      if (throttleIssue) {
        issues.push(throttleIssue);
        if (throttleIssue.severity === 'CRITICAL') {
          status = 'CRITICAL';
        } else if (status !== 'CRITICAL') {
          status = 'WARNING';
        }
      }

      // Check for XID errors
      const xidErrors = await this.checkXidErrors();
      if (xidErrors.length > 0) {
        for (const error of xidErrors) {
          issues.push({
            type: 'ERROR',
            severity: 'CRITICAL',
            message: `GPU XID Error: ${error}`,
            timestamp: new Date(),
          });
        }
        status = 'CRITICAL';
      }

    } catch (error) {
      log.error({ error }, 'Failed to perform health check');
      status = 'UNKNOWN';
      issues.push({
        type: 'ERROR',
        severity: 'CRITICAL',
        message: `Health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date(),
      });
    }

    const report: GpuHealthReport = {
      status,
      issues,
      metrics,
      lastCheck: new Date(),
    };

    // Emit events for new issues
    if (this.lastReport) {
      const newIssues = issues.filter(
        issue => !this.lastReport?.issues.some(
          prev => prev.type === issue.type && prev.severity === issue.severity
        )
      );
      for (const issue of newIssues) {
        this.emit('issue', issue);
        log.warn({ issue }, 'GPU health issue detected');
      }
    }

    // Emit status change
    if (this.lastReport?.status !== status) {
      this.emit('statusChange', status, this.lastReport?.status ?? 'UNKNOWN');
      log.info({ oldStatus: this.lastReport?.status, newStatus: status }, 'GPU health status changed');
    }

    this.lastReport = report;
    this.emit('healthCheck', report);

    return report;
  }

  /**
   * Collect GPU metrics
   */
  private async collectMetrics(): Promise<GpuMetrics> {
    // Return mock metrics if in mock mode
    if (this.config?.mockGpu) {
      return this.generateMockMetrics();
    }

    const output = execSync(
      'nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,fan.speed --format=csv,noheader,nounits',
      { encoding: 'utf-8' }
    );

    const parts = output.trim().split(', ').map(s => s.trim());

    const parseValue = (str: string | undefined, defaultValue: number): number => {
      if (!str || str === '[N/A]' || str === 'N/A') {
        return defaultValue;
      }
      const num = parseFloat(str);
      return isNaN(num) ? defaultValue : num;
    };

    return {
      temperature: parseValue(parts[0], 0),
      utilizationGpu: parseValue(parts[1], 0),
      utilizationMemory: parseValue(parts[2], 0),
      memoryUsed: parseValue(parts[3], 0),
      memoryTotal: parseValue(parts[4], 80000),
      powerDraw: parseValue(parts[5], 0),
      fanSpeed: parseValue(parts[6], 0),
    };
  }

  /**
   * Detect thermal throttling
   */
  private async detectThrottling(metrics: GpuMetrics): Promise<GpuHealthIssue | null> {
    // Skip throttle detection in mock mode
    if (this.config?.mockGpu) {
      return null;
    }

    try {
      // Check for performance state (P-state)
      const pStateOutput = execSync(
        'nvidia-smi --query-gpu=pstate --format=csv,noheader',
        { encoding: 'utf-8' }
      );
      const pState = pStateOutput.trim();

      // P0 = max performance, P8 = idle, higher numbers = more throttled
      // If temperature is high and GPU is not at P0, likely throttling
      if (metrics.temperature >= THROTTLE_DETECTION.TEMP_THROTTLE_THRESHOLD) {
        if (pState !== 'P0' && metrics.utilizationGpu > THROTTLE_DETECTION.EXPECTED_MIN_UTIL) {
          return {
            type: 'THROTTLING',
            severity: 'WARNING',
            message: `GPU may be thermal throttling (temp: ${metrics.temperature}°C, P-state: ${pState})`,
            value: metrics.temperature,
            threshold: THROTTLE_DETECTION.TEMP_THROTTLE_THRESHOLD,
            timestamp: new Date(),
          };
        }
      }

      // Check clock throttle reasons
      const throttleOutput = execSync(
        'nvidia-smi --query-gpu=clocks_throttle_reasons.active --format=csv,noheader',
        { encoding: 'utf-8' }
      );
      const throttleReason = throttleOutput.trim();

      if (throttleReason && throttleReason !== 'Not Active' && throttleReason !== '[N/A]') {
        return {
          type: 'THROTTLING',
          severity: 'WARNING',
          message: `GPU throttling active: ${throttleReason}`,
          timestamp: new Date(),
        };
      }

    } catch (error) {
      // nvidia-smi command may not support all queries
      log.debug({ error }, 'Could not check throttling status');
    }

    return null;
  }

  /**
   * Check for XID errors in system log
   */
  private async checkXidErrors(): Promise<string[]> {
    // Skip XID error check in mock mode
    if (this.config?.mockGpu) {
      return [];
    }

    const errors: string[] = [];

    try {
      // Check dmesg for recent NVIDIA XID errors (last 5 minutes)
      const output = execSync(
        'dmesg --time-format iso 2>/dev/null | grep -i "NVRM: Xid" | tail -5',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      const lines = output.trim().split('\n').filter(line => line.length > 0);
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      for (const line of lines) {
        // Parse timestamp and check if recent
        const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (match && match[1]) {
          const timestamp = new Date(match[1]).getTime();
          if (timestamp > fiveMinutesAgo) {
            // Extract XID number
            const xidMatch = line.match(/Xid.*?: (\d+)/i);
            if (xidMatch && xidMatch[1]) {
              errors.push(`XID ${xidMatch[1]}: ${this.getXidDescription(parseInt(xidMatch[1], 10))}`);
            }
          }
        }
      }
    } catch {
      // dmesg may not be available or accessible
      log.debug('Could not check XID errors (dmesg not accessible)');
    }

    return errors;
  }

  /**
   * Get human-readable XID error description
   */
  private getXidDescription(xid: number): string {
    const descriptions: Record<number, string> = {
      13: 'Graphics Engine Exception',
      31: 'GPU memory page fault',
      32: 'Invalid or corrupted push buffer stream',
      38: 'Driver firmware error',
      43: 'GPU stopped processing',
      45: 'Preemptive cleanup, due to previous errors',
      48: 'Double Bit ECC Error',
      61: 'Internal micro-controller breakpoint/warning',
      62: 'Internal micro-controller halt',
      63: 'ECC page retirement or row remapping recording event',
      64: 'ECC page retirement or row remapper recording failure',
      68: 'NVDEC0 Exception',
      69: 'Graphics Engine class error',
      74: 'NVLink error',
      79: 'GPU has fallen off the bus',
      92: 'High single-bit ECC error rate',
      94: 'Contained ECC error',
      95: 'Uncontained ECC error',
    };

    return descriptions[xid] ?? 'Unknown error';
  }

  /**
   * Get last health report
   */
  getLastReport(): GpuHealthReport | null {
    return this.lastReport;
  }

  /**
   * Get current health status
   */
  getStatus(): GpuHealthStatus {
    return this.lastReport?.status ?? 'UNKNOWN';
  }

  /**
   * Check if GPU is healthy enough to accept jobs
   */
  canAcceptJobs(): boolean {
    const status = this.getStatus();
    return status === 'HEALTHY' || status === 'WARNING';
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }
}
