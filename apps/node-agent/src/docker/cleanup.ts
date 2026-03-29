import { getDockerClient } from './client.js';
import { dockerLogger } from '../utils/logger.js';

const log = dockerLogger();

/**
 * Cleanup Result
 */
export interface CleanupResult {
  containersRemoved: number;
  imagesRemoved: number;
  spaceReclaimed: number;
  orphanedContainers: string[];
}

/**
 * Docker Cleanup Manager
 */
export class CleanupManager {
  private readonly agentLabel = 'a2e.managed';

  /**
   * Find orphaned containers (created by agent but not tracked)
   */
  async findOrphanedContainers(): Promise<string[]> {
    const client = getDockerClient();
    const orphaned: string[] = [];

    try {
      const containers = await client.listContainers(true);

      for (const container of containers) {
        // Check if this is an a2e-managed container
        if (container.Labels?.[this.agentLabel] === 'true') {
          // Check if it's in a stopped/exited state
          if (container.State === 'exited' || container.State === 'dead') {
            orphaned.push(container.Id);
            log.debug(
              { containerId: container.Id, state: container.State },
              'Found orphaned container'
            );
          }
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to find orphaned containers');
    }

    return orphaned;
  }

  /**
   * Clean up orphaned containers from previous runs
   */
  async cleanupOrphanedContainers(): Promise<string[]> {
    const client = getDockerClient();
    const orphaned = await this.findOrphanedContainers();
    const removed: string[] = [];

    for (const containerId of orphaned) {
      try {
        const container = client.getContainer(containerId);

        // Get container info for logging
        const info = await container.inspect();
        const jobId = info.Config?.Labels?.['a2e.job.id'] ?? 'unknown';

        // Remove container
        await container.remove({ force: true, v: true });
        removed.push(containerId);

        log.info({ containerId, jobId }, 'Removed orphaned container');
      } catch (error) {
        log.error({ error, containerId }, 'Failed to remove orphaned container');
      }
    }

    return removed;
  }

  /**
   * Clean up completed/exited containers
   */
  async cleanupExitedContainers(olderThanMinutes: number = 60): Promise<string[]> {
    const client = getDockerClient();
    const removed: string[] = [];
    const cutoffTime = Date.now() - olderThanMinutes * 60 * 1000;

    try {
      const containers = await client.listContainers(true);

      for (const container of containers) {
        // Only clean up a2e-managed containers
        if (container.Labels?.[this.agentLabel] !== 'true') {
          continue;
        }

        // Only clean up exited/dead containers
        if (container.State !== 'exited' && container.State !== 'dead') {
          continue;
        }

        // Check age
        const createdTime = (container.Created ?? 0) * 1000;
        if (createdTime < cutoffTime) {
          try {
            const containerObj = client.getContainer(container.Id);
            await containerObj.remove({ force: true, v: true });
            removed.push(container.Id);

            log.debug({ containerId: container.Id }, 'Removed old exited container');
          } catch (error) {
            log.warn({ error, containerId: container.Id }, 'Failed to remove container');
          }
        }
      }
    } catch (error) {
      log.error({ error }, 'Failed to cleanup exited containers');
    }

    if (removed.length > 0) {
      log.info({ count: removed.length }, 'Cleaned up exited containers');
    }

    return removed;
  }

  /**
   * Clean up dangling images
   */
  async cleanupDanglingImages(): Promise<{ count: number; spaceReclaimed: number }> {
    const client = getDockerClient();

    try {
      const result = await client.pruneImages(true);
      log.info(
        { count: result.count, spaceMB: Math.round(result.spaceReclaimed / 1024 / 1024) },
        'Cleaned up dangling images'
      );
      return result;
    } catch (error) {
      log.error({ error }, 'Failed to cleanup dangling images');
      return { count: 0, spaceReclaimed: 0 };
    }
  }

  /**
   * Full cleanup routine
   */
  async performFullCleanup(): Promise<CleanupResult> {
    log.info('Starting full Docker cleanup');

    // Clean up orphaned containers
    const orphaned = await this.cleanupOrphanedContainers();

    // Clean up old exited containers
    const exited = await this.cleanupExitedContainers();

    // Clean up dangling images
    const images = await this.cleanupDanglingImages();

    // Prune containers
    const client = getDockerClient();
    let containerPruneResult = { count: 0, spaceReclaimed: 0 };
    try {
      containerPruneResult = await client.pruneContainers();
    } catch (error) {
      log.warn({ error }, 'Container prune failed');
    }

    const result: CleanupResult = {
      containersRemoved: orphaned.length + exited.length + containerPruneResult.count,
      imagesRemoved: images.count,
      spaceReclaimed: images.spaceReclaimed + containerPruneResult.spaceReclaimed,
      orphanedContainers: orphaned,
    };

    log.info(
      {
        containersRemoved: result.containersRemoved,
        imagesRemoved: result.imagesRemoved,
        spaceMB: Math.round(result.spaceReclaimed / 1024 / 1024),
      },
      'Full cleanup completed'
    );

    return result;
  }

  /**
   * Check disk usage and clean if necessary
   */
  async checkAndCleanIfNeeded(maxUsagePercent: number = 80): Promise<boolean> {
    try {
      const client = getDockerClient();

      // Get Docker root directory disk usage
      // This is a simplified check - in production you'd want to check the actual disk
      const usage = await client.getDiskUsage();
      const totalUsage = usage.containers + usage.images + usage.volumes + usage.buildCache;

      // If usage exceeds threshold, perform cleanup
      // Note: This is a rough estimate since we don't have total disk info from Docker API
      const usageGB = totalUsage / (1024 * 1024 * 1024);

      log.debug({ usageGB, maxPercent: maxUsagePercent }, 'Checking Docker disk usage');

      if (usageGB > 50) { // Arbitrary threshold of 50GB
        log.info({ usageGB }, 'Docker usage high, performing cleanup');
        await this.performFullCleanup();
        return true;
      }

      return false;
    } catch (error) {
      log.error({ error }, 'Failed to check disk usage');
      return false;
    }
  }

  /**
   * Start periodic cleanup
   */
  startPeriodicCleanup(intervalMinutes: number = 60): NodeJS.Timeout {
    log.info({ intervalMinutes }, 'Starting periodic cleanup');

    return setInterval(async () => {
      try {
        await this.cleanupExitedContainers(60);
        await this.cleanupDanglingImages();
      } catch (error) {
        log.error({ error }, 'Periodic cleanup failed');
      }
    }, intervalMinutes * 60 * 1000);
  }
}
