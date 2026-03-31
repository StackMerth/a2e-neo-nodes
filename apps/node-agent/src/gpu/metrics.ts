import { execSync } from 'child_process';
import type { GpuMetrics } from '../api/types.js';
import type { GpuConfig } from '../config.js';
import { gpuLogger } from '../utils/logger.js';

const log = gpuLogger();

/**
 * Cached metrics with timestamp
 */
interface CachedMetrics {
  metrics: GpuMetrics;
  timestamp: number;
}

/**
 * GPU Metrics Collector - Collects GPU metrics using nvidia-smi
 */
export class GpuMetricsCollector {
  private cache: CachedMetrics | null = null;
  private readonly cacheTimeout: number = 5000; // 5 seconds
  private readonly config?: GpuConfig;

  constructor(config?: GpuConfig) {
    this.config = config;
  }

  /**
   * Generate mock metrics with realistic variation
   */
  private generateMockMetrics(): GpuMetrics {
    // Simulate realistic GPU metrics with some variation
    const baseTemp = 45 + Math.random() * 15; // 45-60°C idle range
    const baseUtil = Math.random() * 10; // 0-10% idle utilization
    const baseMem = 2000 + Math.random() * 1000; // 2-3GB base usage

    return {
      temperature: Math.round(baseTemp),
      utilizationGpu: Math.round(baseUtil),
      utilizationMemory: Math.round(baseUtil * 0.5),
      memoryUsed: Math.round(baseMem),
      memoryTotal: this.config?.mockVram ?? 81920,
      powerDraw: Math.round(80 + Math.random() * 20), // 80-100W idle
      fanSpeed: Math.round(30 + Math.random() * 10), // 30-40% fan
    };
  }

  /**
   * Collect GPU metrics
   */
  async collect(): Promise<GpuMetrics> {
    // Check cache
    if (this.cache && Date.now() - this.cache.timestamp < this.cacheTimeout) {
      return this.cache.metrics;
    }

    // Return mock metrics if in mock mode
    if (this.config?.mockGpu) {
      const metrics = this.generateMockMetrics();
      this.cache = { metrics, timestamp: Date.now() };
      log.debug({ temperature: metrics.temperature, gpuUtil: metrics.utilizationGpu }, 'Mock GPU metrics');
      return metrics;
    }

    try {
      const output = execSync(
        'nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,fan.speed --format=csv,noheader,nounits',
        { encoding: 'utf-8' }
      );

      const parts = output.trim().split(', ').map(s => s.trim());

      // Parse values (handle [N/A] values)
      const parseValue = (str: string | undefined, defaultValue: number): number => {
        if (!str || str === '[N/A]' || str === 'N/A') {
          return defaultValue;
        }
        const num = parseFloat(str);
        return isNaN(num) ? defaultValue : num;
      };

      const metrics: GpuMetrics = {
        temperature: parseValue(parts[0], 0),
        utilizationGpu: parseValue(parts[1], 0),
        utilizationMemory: parseValue(parts[2], 0),
        memoryUsed: parseValue(parts[3], 0),
        memoryTotal: parseValue(parts[4], 80000),
        powerDraw: parseValue(parts[5], undefined as unknown as number),
        fanSpeed: parseValue(parts[6], undefined as unknown as number),
      };

      // Remove undefined optional fields
      if (metrics.powerDraw === undefined || isNaN(metrics.powerDraw)) {
        delete (metrics as Partial<GpuMetrics>).powerDraw;
      }
      if (metrics.fanSpeed === undefined || isNaN(metrics.fanSpeed)) {
        delete (metrics as Partial<GpuMetrics>).fanSpeed;
      }

      // Update cache
      this.cache = {
        metrics,
        timestamp: Date.now(),
      };

      log.debug(
        {
          temperature: metrics.temperature,
          gpuUtil: metrics.utilizationGpu,
          memoryUsed: metrics.memoryUsed,
        },
        'Collected GPU metrics'
      );

      return metrics;
    } catch (error) {
      log.error({ error }, 'Failed to collect GPU metrics');

      // Return default metrics on error
      return {
        temperature: 0,
        utilizationGpu: 0,
        utilizationMemory: 0,
        memoryUsed: 0,
        memoryTotal: 80000,
      };
    }
  }

  /**
   * Get cached metrics without refreshing
   */
  getCached(): GpuMetrics | null {
    return this.cache?.metrics ?? null;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache = null;
  }
}
