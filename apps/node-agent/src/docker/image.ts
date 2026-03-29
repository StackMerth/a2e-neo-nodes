import type Docker from 'dockerode';
import { getDockerClient } from './client.js';
import { dockerLogger } from '../utils/logger.js';

const log = dockerLogger();

/**
 * Image Pull Progress
 */
export interface ImagePullProgress {
  status: string;
  progress?: string;
  id?: string;
  progressDetail?: {
    current?: number;
    total?: number;
  };
}

/**
 * Image Info
 */
export interface ImageInfo {
  id: string;
  repoTags: string[];
  size: number;
  created: Date;
  labels?: Record<string, string>;
}

/**
 * Image Manager - Handles Docker image operations
 */
export class ImageManager {
  private readonly trustedRegistries: string[];
  private pullCache: Map<string, Promise<void>> = new Map();

  constructor(trustedRegistries: string[] = []) {
    this.trustedRegistries = trustedRegistries;
  }

  /**
   * Check if image is from a trusted registry
   */
  isImageTrusted(imageName: string): boolean {
    // If no trusted registries configured, allow all
    if (this.trustedRegistries.length === 0) {
      return true;
    }

    // Check if image starts with any trusted registry
    for (const registry of this.trustedRegistries) {
      if (imageName.startsWith(registry)) {
        return true;
      }
    }

    // Check for official Docker Hub images (no registry prefix)
    if (!imageName.includes('/') || imageName.startsWith('library/')) {
      // Official images are considered trusted if no restrictions
      return this.trustedRegistries.includes('docker.io');
    }

    return false;
  }

  /**
   * Check if image exists locally
   */
  async exists(imageName: string): Promise<boolean> {
    const client = getDockerClient();
    return client.imageExists(imageName);
  }

  /**
   * Get image info
   */
  async getInfo(imageName: string): Promise<ImageInfo | null> {
    const client = getDockerClient();

    try {
      const image = client.getImage(imageName);
      const inspect = await image.inspect();

      return {
        id: inspect.Id,
        repoTags: inspect.RepoTags ?? [],
        size: inspect.Size ?? 0,
        created: new Date(inspect.Created),
        labels: inspect.Config?.Labels,
      };
    } catch {
      return null;
    }
  }

  /**
   * Pull image with progress tracking
   */
  async pull(
    imageName: string,
    onProgress?: (progress: ImagePullProgress) => void,
    timeout?: number
  ): Promise<void> {
    // Check trust
    if (!this.isImageTrusted(imageName)) {
      throw new Error(`Image ${imageName} is not from a trusted registry`);
    }

    // Check if already pulling
    const existingPull = this.pullCache.get(imageName);
    if (existingPull) {
      log.debug({ image: imageName }, 'Image pull already in progress, waiting');
      return existingPull;
    }

    log.info({ image: imageName }, 'Pulling image');

    const pullPromise = this.doPull(imageName, onProgress, timeout);
    this.pullCache.set(imageName, pullPromise);

    try {
      await pullPromise;
    } finally {
      this.pullCache.delete(imageName);
    }
  }

  /**
   * Internal pull implementation
   */
  private async doPull(
    imageName: string,
    onProgress?: (progress: ImagePullProgress) => void,
    timeout?: number
  ): Promise<void> {
    const client = getDockerClient();

    const pullWithTimeout = new Promise<void>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;

      if (timeout) {
        timeoutId = setTimeout(() => {
          reject(new Error(`Image pull timed out after ${timeout}ms`));
        }, timeout);
      }

      client
        .pullImage(imageName, (event) => {
          if (onProgress) {
            onProgress(event as ImagePullProgress);
          }
        })
        .then(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          resolve();
        })
        .catch((err) => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          reject(err);
        });
    });

    await pullWithTimeout;
  }

  /**
   * Ensure image exists (pull if not)
   */
  async ensure(
    imageName: string,
    onProgress?: (progress: ImagePullProgress) => void,
    timeout?: number
  ): Promise<boolean> {
    const exists = await this.exists(imageName);

    if (exists) {
      log.debug({ image: imageName }, 'Image already exists locally');
      return false; // Did not pull
    }

    await this.pull(imageName, onProgress, timeout);
    return true; // Did pull
  }

  /**
   * List local images
   */
  async list(): Promise<ImageInfo[]> {
    const client = getDockerClient();
    const images = await client.listImages();

    return images.map((img: Docker.ImageInfo) => ({
      id: img.Id,
      repoTags: img.RepoTags ?? [],
      size: img.Size ?? 0,
      created: new Date((img.Created ?? 0) * 1000),
      labels: img.Labels,
    }));
  }

  /**
   * Remove an image
   */
  async remove(imageName: string, force: boolean = false): Promise<void> {
    const client = getDockerClient();

    try {
      const image = client.getImage(imageName);
      await image.remove({ force });
      log.info({ image: imageName }, 'Image removed');
    } catch (error) {
      log.error({ error, image: imageName }, 'Failed to remove image');
      throw error;
    }
  }

  /**
   * Clean up unused images
   */
  async cleanup(olderThanDays: number = 7, keepMinimum: number = 5): Promise<{
    removed: string[];
    spaceReclaimed: number;
  }> {
    const images = await this.list();
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    let spaceReclaimed = 0;

    // Sort by creation date (oldest first)
    const sortedImages = images
      .filter(img => img.repoTags.length > 0 && img.repoTags[0] !== '<none>:<none>')
      .sort((a, b) => a.created.getTime() - b.created.getTime());

    // Keep at least keepMinimum images
    const candidates = sortedImages.slice(0, Math.max(0, sortedImages.length - keepMinimum));

    for (const image of candidates) {
      if (image.created.getTime() < cutoffTime) {
        try {
          await this.remove(image.repoTags[0] ?? image.id);
          removed.push(image.repoTags[0] ?? image.id);
          spaceReclaimed += image.size;
        } catch {
          // Image may be in use, skip
        }
      }
    }

    log.info(
      { removedCount: removed.length, spaceReclaimedMB: Math.round(spaceReclaimed / 1024 / 1024) },
      'Image cleanup completed'
    );

    return { removed, spaceReclaimed };
  }

  /**
   * Get total size of local images
   */
  async getTotalSize(): Promise<number> {
    const images = await this.list();
    return images.reduce((sum, img) => sum + img.size, 0);
  }
}
