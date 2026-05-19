import { execSync } from 'child_process';
import type { GpuConfig } from '../config.js';
import type { GpuTier } from '../api/types.js';
import { gpuLogger } from '../utils/logger.js';

const log = gpuLogger();

/**
 * GPU Information
 */
export interface GpuInfo {
  model: string;
  tier: GpuTier;
  count: number;
  vram: number; // in MB
  driver: string;
  cudaVersion?: string;
  uuid?: string;
}

/**
 * GPU Tier Mapping
 */
const GPU_TIER_MAP: Record<string, GpuTier> = {
  // H100 variants
  'H100 SXM': 'H100',
  'H100 SXM5': 'H100',
  'H100 PCIe': 'H100',
  'H100 NVL': 'H100',
  'NVIDIA H100': 'H100',

  // H200 variants
  'H200 SXM': 'H200',
  'NVIDIA H200': 'H200',

  // B200 variants
  'B200 SXM': 'B200',
  'NVIDIA B200': 'B200',

  // B300 variants
  'B300 SXM': 'B300',
  'NVIDIA B300': 'B300',

  // GB300 variants
  'GB300 NVL': 'GB300',
  'NVIDIA GB300': 'GB300',

  // C2 wave 2: consumer / prosumer GPUs
  'RTX 4090': 'RTX_4090',
  'GeForce RTX 4090': 'RTX_4090',
  'NVIDIA GeForce RTX 4090': 'RTX_4090',
  'RTX 3090': 'RTX_3090',
  'GeForce RTX 3090': 'RTX_3090',
  'NVIDIA GeForce RTX 3090': 'RTX_3090',
};

/**
 * GPU Detector - Detects NVIDIA GPUs using nvidia-smi
 */
export class GpuDetector {
  private readonly config: GpuConfig;
  private gpuInfo: GpuInfo | null = null;

  constructor(config: GpuConfig) {
    this.config = config;
  }

  /**
   * Check if nvidia-smi is available
   */
  private checkNvidiaSmi(): boolean {
    try {
      execSync('which nvidia-smi', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse GPU model to determine tier
   */
  private classifyGpuTier(model: string): GpuTier {
    // Check for direct match
    for (const [pattern, tier] of Object.entries(GPU_TIER_MAP)) {
      if (model.includes(pattern)) {
        return tier;
      }
    }

    // C2 wave 2: unknown consumer RTX cards (RTX 4080/4070/3080/etc.)
    // land in CONSUMER so they show up in the marketplace with the
    // correct rate floor instead of being mis-priced as H100s.
    if (model.includes('GeForce') || model.includes('RTX')) {
      log.warn({ model }, 'Unknown consumer GPU model, defaulting to CONSUMER tier');
      return 'CONSUMER';
    }

    // Datacenter NVIDIA cards we don't recognize still default to H100
    // as before — wrong tier is a smaller blast radius than refusing
    // to register at all.
    if (model.includes('NVIDIA')) {
      log.warn({ model }, 'Unknown GPU model, defaulting to H100');
      return 'H100';
    }

    throw new Error(`Unsupported GPU model: ${model}`);
  }

  /**
   * Detect GPUs using nvidia-smi
   */
  async detect(): Promise<GpuInfo | null> {
    // Mock GPU mode for testing without real hardware
    if (this.config.mockGpu) {
      log.warn('Mock GPU mode enabled - using simulated GPU');
      const mockTier = this.config.tier ?? 'H100';
      this.gpuInfo = {
        model: this.config.mockModel ?? 'NVIDIA H100 80GB HBM3 (Mock)',
        tier: mockTier,
        count: 1,
        vram: this.config.mockVram ?? 81920,
        driver: '535.154.05 (Mock)',
        cudaVersion: '12.2 (Mock)',
        uuid: `MOCK-GPU-${Date.now().toString(36).toUpperCase()}`,
      };
      log.info(
        {
          model: this.gpuInfo.model,
          tier: this.gpuInfo.tier,
          vram: this.gpuInfo.vram,
        },
        'Mock GPU initialized'
      );
      return this.gpuInfo;
    }

    if (!this.config.autoDetect) {
      log.info('GPU auto-detection disabled');
      if (this.config.tier) {
        this.gpuInfo = {
          model: 'Manual',
          tier: this.config.tier,
          count: 1,
          vram: 80000, // Default for H100
          driver: 'unknown',
        };
        return this.gpuInfo;
      }
      return null;
    }

    if (!this.checkNvidiaSmi()) {
      log.error('nvidia-smi not found');
      throw new Error('nvidia-smi not found. NVIDIA drivers may not be installed.');
    }

    try {
      // Query GPU information
      const output = execSync(
        'nvidia-smi --query-gpu=name,memory.total,driver_version,uuid --format=csv,noheader,nounits',
        { encoding: 'utf-8' }
      );

      const lines = output.trim().split('\n');
      if (lines.length === 0 || !lines[0]) {
        throw new Error('No GPUs detected');
      }

      // Parse first GPU (primary)
      const firstLine = lines[0];
      const parts = firstLine.split(', ').map(s => s.trim());

      if (parts.length < 3) {
        throw new Error(`Invalid nvidia-smi output: ${firstLine}`);
      }

      const [model, vramStr, driver, uuid] = parts;

      if (!model || !vramStr || !driver) {
        throw new Error('Missing GPU information from nvidia-smi');
      }

      const vram = parseInt(vramStr, 10);

      // Get CUDA version
      let cudaVersion: string | undefined;
      try {
        const cudaOutput = execSync('nvidia-smi --query-gpu=compute_cap --format=csv,noheader', {
          encoding: 'utf-8',
        });
        cudaVersion = cudaOutput.trim();
      } catch {
        log.warn('Could not determine CUDA version');
      }

      // Determine tier (use config override if set)
      const tier = this.config.tier ?? this.classifyGpuTier(model);

      this.gpuInfo = {
        model,
        tier,
        count: lines.length,
        vram,
        driver,
        cudaVersion,
        uuid,
      };

      log.info(
        {
          model,
          tier,
          count: lines.length,
          vram,
          driver,
        },
        'GPU detected'
      );

      return this.gpuInfo;
    } catch (error) {
      log.error({ error }, 'Failed to detect GPU');
      throw error;
    }
  }

  /**
   * Get cached GPU info
   */
  getGpuInfo(): GpuInfo | null {
    return this.gpuInfo;
  }

  /**
   * Verify GPU is accessible
   */
  async verify(): Promise<boolean> {
    try {
      execSync('nvidia-smi', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
