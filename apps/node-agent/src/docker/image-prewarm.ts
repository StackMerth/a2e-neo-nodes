/**
 * M2 / B2: docker image prewarm during idle.
 *
 * Periodically asks the API which template images are popular right
 * now (`GET /v1/templates/prewarm-list` returns the top-N), then docker
 * pulls each one in the background. The result is that when a buyer
 * picks the most-used template, the image is already on disk and
 * Jupyter is up in <30s instead of ~5 minutes for a cold pull.
 *
 * Idle gating: this loop only runs when the agent is ONLINE with no
 * current job. It bails immediately if the state shifts to BUSY so
 * a real workload never fights the prewarm for disk/network.
 *
 * Cadence: 30 minute check by default. Image popularity changes slowly,
 * and we don't want to hammer Docker Hub. The first prewarm runs ~60s
 * after agent start so registration and the first heartbeat finish
 * cleanly first.
 *
 * Failure handling: a failed pull (network blip, image gone, registry
 * 429) is logged and skipped. Next interval tries again. We never
 * crash the agent for a prewarm miss.
 */

import { ImageManager } from './image.js';
import type { DockerClient } from './client.js';
import { dockerLogger } from '../utils/logger.js';
import type { Config } from '../config.js';

const log = dockerLogger();

const PREWARM_INTERVAL_MS = parseInt(process.env.A2E_PREWARM_INTERVAL_MS ?? '1800000', 10); // 30m
const PREWARM_INITIAL_DELAY_MS = parseInt(process.env.A2E_PREWARM_INITIAL_DELAY_MS ?? '60000', 10); // 60s
const PREWARM_PER_IMAGE_TIMEOUT_MS = parseInt(process.env.A2E_PREWARM_PULL_TIMEOUT_MS ?? '900000', 10); // 15m

interface PrewarmTemplate {
  slug: string;
  dockerImage: string;
  popularity: number;
}

interface PrewarmListResponse {
  templates: PrewarmTemplate[];
}

/**
 * Lightweight predicate the prewarm loop calls before each cycle.
 * Returning false aborts that cycle (e.g. agent is BUSY).
 */
export type IsIdleFn = () => boolean;

export class ImagePrewarmService {
  private readonly imageManager: ImageManager;
  private readonly apiUrl: string;
  private readonly isIdle: IsIdleFn;

  private intervalHandle: NodeJS.Timeout | null = null;
  private startupTimerHandle: NodeJS.Timeout | null = null;
  private currentlyPulling = false;
  private stopped = false;

  constructor(_dockerClient: DockerClient, config: Config, isIdle: IsIdleFn) {
    // ImageManager pulls the singleton docker client itself via
    // getDockerClient(); the parameter is kept on this constructor
    // for backward compat with callers that pre-resolved the client.
    this.imageManager = new ImageManager();
    this.apiUrl = config.server.apiUrl.replace(/\/$/, '');
    this.isIdle = isIdle;
  }

  start(): void {
    log.info(
      { intervalMs: PREWARM_INTERVAL_MS, initialDelayMs: PREWARM_INITIAL_DELAY_MS },
      'Image prewarm service starting',
    );

    this.startupTimerHandle = setTimeout(() => {
      void this.tick();
      this.intervalHandle = setInterval(() => void this.tick(), PREWARM_INTERVAL_MS);
    }, PREWARM_INITIAL_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimerHandle) {
      clearTimeout(this.startupTimerHandle);
      this.startupTimerHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    log.info('Image prewarm service stopped');
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.currentlyPulling) {
      log.debug('Prewarm tick skipped — previous pull still in progress');
      return;
    }
    if (!this.isIdle()) {
      log.debug('Prewarm tick skipped — agent is not idle');
      return;
    }

    let templates: PrewarmTemplate[] = [];
    try {
      templates = await this.fetchPrewarmList();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Failed to fetch prewarm list');
      return;
    }

    if (templates.length === 0) {
      log.debug('Prewarm list empty — nothing to do');
      return;
    }

    this.currentlyPulling = true;
    try {
      for (const t of templates) {
        if (this.stopped || !this.isIdle()) {
          log.info({ slug: t.slug }, 'Aborting prewarm — agent no longer idle');
          break;
        }
        await this.pullSafely(t);
      }
    } finally {
      this.currentlyPulling = false;
    }
  }

  private async fetchPrewarmList(): Promise<PrewarmTemplate[]> {
    const url = `${this.apiUrl}/v1/templates/prewarm-list`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      const data = (await res.json()) as PrewarmListResponse;
      return Array.isArray(data.templates) ? data.templates : [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async pullSafely(t: PrewarmTemplate): Promise<void> {
    log.info({ slug: t.slug, image: t.dockerImage, popularity: t.popularity }, 'Prewarm pull starting');
    const start = Date.now();
    try {
      await this.imageManager.pull(t.dockerImage, undefined, PREWARM_PER_IMAGE_TIMEOUT_MS);
      log.info(
        { slug: t.slug, image: t.dockerImage, durationMs: Date.now() - start },
        'Prewarm pull complete',
      );
    } catch (err) {
      log.warn(
        { slug: t.slug, image: t.dockerImage, err: (err as Error).message },
        'Prewarm pull failed (non-fatal)',
      );
    }
  }
}
