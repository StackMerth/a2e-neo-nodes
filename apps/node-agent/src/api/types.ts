/**
 * API Types for A²E Node Agent
 */

// GPU Tiers
export type GpuTier = 'H100' | 'H200' | 'B200' | 'B300' | 'GB300';

// Node Status
export type NodeStatus = 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'MAINTENANCE';

// Job Status
export type JobStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * GPU Metrics sent with heartbeat
 */
export interface GpuMetrics {
  temperature: number;
  utilizationGpu: number;
  utilizationMemory: number;
  memoryUsed: number;
  memoryTotal: number;
  powerDraw?: number;
  fanSpeed?: number;
}

/**
 * System Metrics sent with heartbeat
 */
export interface SystemMetrics {
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptime: number;
}

/**
 * Node Specifications for registration
 */
export interface NodeSpecs {
  gpuModel: string;
  gpuTier: GpuTier;
  gpuCount: number;
  gpuVram: number;
  gpuDriver: string;
  cudaVersion?: string;
  hostname: string;
  os: string;
  osVersion: string;
  totalMemory: number;
  totalCpus: number;
  dockerVersion: string;
  agentVersion: string;
}

/**
 * Registration Request
 */
export interface RegisterNodeRequest {
  walletAddress?: string;
  name: string;
  specs: NodeSpecs;
}

/**
 * Registration Response
 */
export interface RegisterNodeResponse {
  nodeId: string;
  apiKey?: string;
  config?: {
    heartbeatInterval?: number;
    jobPollInterval?: number;
  };
}

/**
 * Heartbeat Request
 */
export interface HeartbeatRequest {
  status: NodeStatus;
  currentJobId?: string;
  gpuMetrics: GpuMetrics;
  systemMetrics: SystemMetrics;
  agentVersion: string;
}

/**
 * Heartbeat Response
 */
export interface HeartbeatResponse {
  acknowledged: boolean;
  commands?: NodeCommand[];
  config?: {
    heartbeatInterval?: number;
    jobPollInterval?: number;
  };
}

/**
 * Node Commands from server
 */
export interface NodeCommand {
  id: string;
  type: 'PAUSE' | 'RESUME' | 'RESTART' | 'UPDATE' | 'DRAIN';
  payload?: Record<string, unknown>;
}

/**
 * Job Poll Request
 */
export interface JobPollRequest {
  status: 'idle' | 'busy';
  capabilities: {
    gpuTier: GpuTier;
    gpuCount: number;
    availableVram: number;
  };
}

/**
 * Job Details
 */
export interface Job {
  id: string;
  image: string;
  command?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  timeout: number;
  resources?: {
    gpuCount?: number;
    memory?: string;
    cpus?: number;
  };
  volumes?: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
  priority?: number;
  gpuDevices?: string;
}

/**
 * Job Poll Response
 */
export interface JobPollResponse {
  job: Job | null;
}

/**
 * Job Accept Request
 */
export interface JobAcceptRequest {
  estimatedDuration?: number;
}

/**
 * Job Accept Response
 */
export interface JobAcceptResponse {
  accepted: boolean;
  job?: Job;
}

/**
 * Job Progress Request
 */
export interface JobProgressRequest {
  progress?: number;
  message?: string;
  metrics?: {
    gpuUtilization?: number;
    memoryUsed?: number;
    elapsedTime?: number;
  };
}

/**
 * Job Complete Request
 */
export interface JobCompleteRequest {
  exitCode: number;
  duration: number;
  output?: string;
  metrics?: {
    totalGpuTime?: number;
    peakMemory?: number;
    avgGpuUtilization?: number;
  };
}

/**
 * Job Fail Request
 */
export interface JobFailRequest {
  error: string;
  exitCode?: number;
  logs?: string;
  retryable?: boolean;
  failureReason?:
    | 'TIMEOUT'
    | 'OOM'
    | 'DOCKER_ERROR'
    | 'IMAGE_PULL_FAILED'
    | 'RUNTIME_ERROR'
    | 'CANCELLED'
    | 'UNKNOWN';
}

/**
 * API Error Response
 */
export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
