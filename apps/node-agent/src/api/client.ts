import * as fs from 'fs';
import type { ServerConfig } from '../config.js';
import { apiLogger } from '../utils/logger.js';
import type {
  RegisterNodeRequest,
  RegisterNodeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  JobPollRequest,
  JobPollResponse,
  JobAcceptRequest,
  JobAcceptResponse,
  JobProgressRequest,
  JobCompleteRequest,
  JobFailRequest,
  ApiError,
} from './types.js';

const log = apiLogger();

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
};

/**
 * API Client Error
 */
export class ApiClientError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly retryable: boolean;

  constructor(message: string, statusCode?: number, code?: string, retryable = false) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A²E API Client
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly retryConfig: RetryConfig;
  private nodeId: string | null = null;

  constructor(config: ServerConfig, retryConfig: Partial<RetryConfig> = {}) {
    this.baseUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = 30000; // 30 seconds default
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

    // Configure TLS via Node.js environment variables
    // This approach works with both native fetch and any HTTP library
    if (config.tls) {
      if (!config.tls.rejectUnauthorized) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        log.warn('TLS certificate validation disabled (rejectUnauthorized=false)');
      }

      if (config.tls.caCertPath) {
        if (fs.existsSync(config.tls.caCertPath)) {
          process.env.NODE_EXTRA_CA_CERTS = config.tls.caCertPath;
          log.info({ path: config.tls.caCertPath }, 'Loaded custom CA certificate');
        } else {
          log.warn({ path: config.tls.caCertPath }, 'CA certificate file not found');
        }
      }

      if (config.tls.clientCertPath && config.tls.clientKeyPath) {
        if (fs.existsSync(config.tls.clientCertPath) && fs.existsSync(config.tls.clientKeyPath)) {
          log.info('Client certificate and key configured for mTLS');
        } else {
          log.warn('Client certificate or key file not found');
        }
      }
    }
  }

  /**
   * Set the node ID for API calls
   */
  setNodeId(nodeId: string): void {
    this.nodeId = nodeId;
  }

  /**
   * Get current node ID
   */
  getNodeId(): string | null {
    return this.nodeId;
  }

  /**
   * Calculate delay for retry attempt
   */
  private calculateRetryDelay(attempt: number, retryAfter?: number): number {
    if (retryAfter) {
      return retryAfter * 1000;
    }

    const delay = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt);
    return Math.min(delay, this.retryConfig.maxDelay);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Make HTTP request with retry logic
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { retries?: number } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = options.retries ?? this.retryConfig.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'User-Agent': 'A2E-Node-Agent/1.0',
        };

        if (this.nodeId) {
          headers['X-Node-ID'] = this.nodeId;
        }

        log.debug({ method, url, attempt }, 'Making API request');

        // Build fetch options
        const fetchOptions: RequestInit = {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        };

        const response = await fetch(url, fetchOptions);

        clearTimeout(timeoutId);

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
          if (attempt < maxRetries) {
            const delay = this.calculateRetryDelay(attempt, retryAfter);
            log.warn({ delay, attempt }, 'Rate limited, retrying after delay');
            await this.sleep(delay);
            continue;
          }
          throw new ApiClientError('Rate limit exceeded', 429, 'RATE_LIMITED', true);
        }

        // Handle server errors (retryable)
        if (response.status >= 500) {
          if (attempt < maxRetries) {
            const delay = this.calculateRetryDelay(attempt);
            log.warn({ status: response.status, delay, attempt }, 'Server error, retrying');
            await this.sleep(delay);
            continue;
          }
          throw new ApiClientError(
            `Server error: ${response.status}`,
            response.status,
            'SERVER_ERROR',
            true
          );
        }

        // Handle client errors (not retryable)
        if (response.status >= 400) {
          let errorData: ApiError;
          try {
            errorData = await response.json() as ApiError;
          } catch {
            errorData = { error: `HTTP ${response.status}` };
          }
          throw new ApiClientError(
            errorData.error || `HTTP ${response.status}`,
            response.status,
            errorData.code,
            false
          );
        }

        // Success
        if (response.status === 204) {
          return {} as T;
        }

        const data = await response.json() as T;
        log.debug({ method, url, status: response.status }, 'API request successful');
        return data;
      } catch (error) {
        if (error instanceof ApiClientError) {
          if (!error.retryable || attempt >= maxRetries) {
            throw error;
          }
          lastError = error;
        } else if (error instanceof Error) {
          // Handle network errors and timeouts
          if (error.name === 'AbortError') {
            log.warn({ attempt }, 'Request timed out');
            lastError = new ApiClientError('Request timed out', undefined, 'TIMEOUT', true);
          } else {
            log.warn({ error: error.message, attempt }, 'Network error');
            lastError = new ApiClientError(error.message, undefined, 'NETWORK_ERROR', true);
          }

          if (attempt < maxRetries) {
            const delay = this.calculateRetryDelay(attempt);
            log.info({ delay, attempt }, 'Retrying after network error');
            await this.sleep(delay);
            continue;
          }
        }
        throw lastError ?? error;
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }

  // ============ Node Registration ============

  /**
   * Register node with A²E
   */
  async registerNode(data: RegisterNodeRequest): Promise<RegisterNodeResponse> {
    log.info({ name: data.name, gpuTier: data.specs.gpuTier }, 'Registering node');
    const response = await this.request<RegisterNodeResponse>('POST', '/v1/nodes', data);
    this.nodeId = response.nodeId;
    log.info({ nodeId: response.nodeId }, 'Node registered successfully');
    return response;
  }

  // ============ Heartbeat ============

  /**
   * Send heartbeat to A²E
   */
  async sendHeartbeat(data: HeartbeatRequest): Promise<HeartbeatResponse> {
    if (!this.nodeId) {
      throw new ApiClientError('Node not registered', undefined, 'NOT_REGISTERED', false);
    }

    log.debug({ nodeId: this.nodeId, status: data.status }, 'Sending heartbeat');
    const response = await this.request<HeartbeatResponse>(
      'POST',
      `/v1/nodes/${this.nodeId}/heartbeat`,
      data,
      { retries: 1 } // Only 1 retry for heartbeats
    );
    return response;
  }

  // ============ Job Operations ============

  /**
   * Poll for available jobs
   */
  async pollJobs(data: JobPollRequest): Promise<JobPollResponse> {
    if (!this.nodeId) {
      throw new ApiClientError('Node not registered', undefined, 'NOT_REGISTERED', false);
    }

    log.debug({ nodeId: this.nodeId, status: data.status }, 'Polling for jobs');
    const response = await this.request<JobPollResponse>(
      'POST',
      `/v1/nodes/${this.nodeId}/jobs/poll`,
      data,
      { retries: 1 }
    );

    if (response.job) {
      log.info({ jobId: response.job.id, image: response.job.image }, 'Job received');
    }

    return response;
  }

  /**
   * Accept a job assignment
   */
  async acceptJob(jobId: string, data: JobAcceptRequest = {}): Promise<JobAcceptResponse> {
    log.info({ jobId }, 'Accepting job');
    return this.request<JobAcceptResponse>('POST', `/v1/jobs/${jobId}/accept`, data);
  }

  /**
   * Reject a job assignment
   */
  async rejectJob(jobId: string, reason: string): Promise<void> {
    log.info({ jobId, reason }, 'Rejecting job');
    await this.request<void>('POST', `/v1/jobs/${jobId}/reject`, { reason });
  }

  /**
   * Report job progress
   */
  async reportProgress(jobId: string, data: JobProgressRequest): Promise<void> {
    log.debug({ jobId, progress: data.progress }, 'Reporting progress');
    await this.request<void>('POST', `/v1/jobs/${jobId}/progress`, data);
  }

  /**
   * Report job completion
   */
  async reportComplete(jobId: string, data: JobCompleteRequest): Promise<void> {
    log.info({ jobId, exitCode: data.exitCode, duration: data.duration }, 'Reporting job complete');
    await this.request<void>('POST', `/v1/jobs/${jobId}/complete`, data);
  }

  /**
   * Report job failure
   */
  async reportFailure(jobId: string, data: JobFailRequest): Promise<void> {
    log.warn({ jobId, error: data.error, failureReason: data.failureReason }, 'Reporting job failure');
    await this.request<void>('POST', `/v1/jobs/${jobId}/fail`, data);
  }

  // ============ Configuration ============

  /**
   * Fetch remote configuration
   */
  async getRemoteConfig(): Promise<Record<string, unknown>> {
    if (!this.nodeId) {
      throw new ApiClientError('Node not registered', undefined, 'NOT_REGISTERED', false);
    }

    log.debug({ nodeId: this.nodeId }, 'Fetching remote configuration');
    return this.request<Record<string, unknown>>('GET', `/v1/nodes/${this.nodeId}/config`);
  }
}

/**
 * Global API client instance
 */
let globalClient: ApiClient | null = null;

/**
 * Initialize global API client
 */
export function initApiClient(config: ServerConfig): ApiClient {
  globalClient = new ApiClient(config);
  return globalClient;
}

/**
 * Get global API client
 */
export function getApiClient(): ApiClient {
  if (!globalClient) {
    throw new Error('API client not initialized. Call initApiClient() first.');
  }
  return globalClient;
}
