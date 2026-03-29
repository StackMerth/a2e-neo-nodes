import Docker from 'dockerode';
import type { DockerConfig } from '../config.js';
import { dockerLogger } from '../utils/logger.js';

const log = dockerLogger();

/**
 * Docker Runtime Info
 */
export interface DockerRuntimeInfo {
  version: string;
  apiVersion: string;
  os: string;
  arch: string;
  kernelVersion: string;
  nvidiaRuntime: boolean;
  runtimes: string[];
}

/**
 * Docker Client Wrapper
 */
export class DockerClient {
  private docker: Docker;
  private readonly config: DockerConfig;
  private connected: boolean = false;
  private runtimeInfo: DockerRuntimeInfo | null = null;

  constructor(config: DockerConfig) {
    this.config = config;
    this.docker = new Docker({ socketPath: config.socketPath });
  }

  /**
   * Get the underlying dockerode instance
   */
  getDocker(): Docker {
    return this.docker;
  }

  /**
   * Connect and verify Docker daemon
   */
  async connect(): Promise<void> {
    log.info({ socketPath: this.config.socketPath }, 'Connecting to Docker daemon');

    try {
      // Ping Docker daemon
      await this.docker.ping();

      // Get version info
      const version = await this.docker.version();
      const info = await this.docker.info();

      // Check for NVIDIA runtime
      const runtimes = Object.keys(info.Runtimes ?? {});
      const hasNvidiaRuntime = runtimes.includes(this.config.gpuRuntime);

      this.runtimeInfo = {
        version: version.Version ?? 'unknown',
        apiVersion: version.ApiVersion ?? 'unknown',
        os: version.Os ?? 'unknown',
        arch: version.Arch ?? 'unknown',
        kernelVersion: version.KernelVersion ?? 'unknown',
        nvidiaRuntime: hasNvidiaRuntime,
        runtimes,
      };

      if (!hasNvidiaRuntime) {
        log.warn(
          { expectedRuntime: this.config.gpuRuntime, availableRuntimes: runtimes },
          'NVIDIA runtime not found. GPU support may not work.'
        );
      }

      this.connected = true;
      log.info(
        {
          version: this.runtimeInfo.version,
          apiVersion: this.runtimeInfo.apiVersion,
          nvidiaRuntime: hasNvidiaRuntime,
        },
        'Connected to Docker daemon'
      );
    } catch (error) {
      this.connected = false;
      log.error({ error }, 'Failed to connect to Docker daemon');
      throw new Error(`Failed to connect to Docker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get runtime info
   */
  getRuntimeInfo(): DockerRuntimeInfo | null {
    return this.runtimeInfo;
  }

  /**
   * Check if NVIDIA runtime is available
   */
  hasNvidiaRuntime(): boolean {
    return this.runtimeInfo?.nvidiaRuntime ?? false;
  }

  /**
   * Ping Docker daemon
   */
  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  /**
   * Reconnect to Docker daemon
   */
  async reconnect(): Promise<void> {
    log.info('Reconnecting to Docker daemon');
    this.docker = new Docker({ socketPath: this.config.socketPath });
    await this.connect();
  }

  /**
   * List containers
   */
  async listContainers(all: boolean = false): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all });
  }

  /**
   * Get container by ID
   */
  getContainer(id: string): Docker.Container {
    return this.docker.getContainer(id);
  }

  /**
   * List images
   */
  async listImages(): Promise<Docker.ImageInfo[]> {
    return this.docker.listImages();
  }

  /**
   * Get image by name
   */
  getImage(name: string): Docker.Image {
    return this.docker.getImage(name);
  }

  /**
   * Pull an image
   */
  async pullImage(
    imageName: string,
    onProgress?: (event: { status: string; progress?: string }) => void
  ): Promise<void> {
    log.info({ image: imageName }, 'Pulling image');

    return new Promise((resolve, reject) => {
      this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          log.error({ error: err, image: imageName }, 'Failed to pull image');
          reject(err);
          return;
        }

        this.docker.modem.followProgress(
          stream,
          (followErr: Error | null) => {
            if (followErr) {
              log.error({ error: followErr, image: imageName }, 'Image pull failed');
              reject(followErr);
            } else {
              log.info({ image: imageName }, 'Image pulled successfully');
              resolve();
            }
          },
          (event: { status: string; progress?: string }) => {
            if (onProgress) {
              onProgress(event);
            }
          }
        );
      });
    });
  }

  /**
   * Check if image exists locally
   */
  async imageExists(imageName: string): Promise<boolean> {
    try {
      const image = this.docker.getImage(imageName);
      await image.inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a container
   */
  async createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    log.debug({ options }, 'Creating container');
    return this.docker.createContainer(options);
  }

  /**
   * Get Docker system info
   */
  async getInfo(): Promise<object> {
    return this.docker.info();
  }

  /**
   * Get disk usage
   */
  async getDiskUsage(): Promise<{
    containers: number;
    images: number;
    volumes: number;
    buildCache: number;
  }> {
    const df = await this.docker.df() as {
      Containers?: Array<{ SizeRw?: number }>;
      Images?: Array<{ Size?: number }>;
      Volumes?: Array<{ UsageData?: { Size?: number } }>;
      BuildCache?: Array<{ Size?: number }>;
    };
    return {
      containers: df.Containers?.reduce((sum: number, c) => sum + (c.SizeRw ?? 0), 0) ?? 0,
      images: df.Images?.reduce((sum: number, i) => sum + (i.Size ?? 0), 0) ?? 0,
      volumes: df.Volumes?.reduce((sum: number, v) => sum + (v.UsageData?.Size ?? 0), 0) ?? 0,
      buildCache: df.BuildCache?.reduce((sum: number, b) => sum + (b.Size ?? 0), 0) ?? 0,
    };
  }

  /**
   * Prune unused containers
   */
  async pruneContainers(): Promise<{ count: number; spaceReclaimed: number }> {
    const result = await this.docker.pruneContainers();
    return {
      count: result.ContainersDeleted?.length ?? 0,
      spaceReclaimed: result.SpaceReclaimed ?? 0,
    };
  }

  /**
   * Prune unused images
   */
  async pruneImages(dangling: boolean = true): Promise<{ count: number; spaceReclaimed: number }> {
    const result = await this.docker.pruneImages({ filters: { dangling: [String(dangling)] } });
    return {
      count: result.ImagesDeleted?.length ?? 0,
      spaceReclaimed: result.SpaceReclaimed ?? 0,
    };
  }
}

/**
 * Global Docker client instance
 */
let globalClient: DockerClient | null = null;

/**
 * Initialize global Docker client
 */
export async function initDockerClient(config: DockerConfig): Promise<DockerClient> {
  globalClient = new DockerClient(config);
  await globalClient.connect();
  return globalClient;
}

/**
 * Get global Docker client
 */
export function getDockerClient(): DockerClient {
  if (!globalClient) {
    throw new Error('Docker client not initialized. Call initDockerClient() first.');
  }
  return globalClient;
}
