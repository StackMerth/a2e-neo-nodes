/**
 * API Types for A²E Node Agent
 */

// GPU Tiers
export type GpuTier =
  | 'H100'
  | 'H200'
  | 'L40S'
  | 'B200'
  | 'B300'
  | 'GB300'
  | 'OTHER'
  | 'CONSUMER'
  | 'RTX_4090'
  | 'RTX_3090';

// C2 wave 2: buyer-declared workload type. Drives the allocator's
// tier-eligibility filter. CONSUMER/RTX_4090/RTX_3090 only match
// INFERENCE requests; TRAINING and MIXED filter them out.
export type WorkloadType = 'INFERENCE' | 'TRAINING' | 'MIXED';

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
  // Launch-blocker #2: server-driven SSH lifecycle. When present, the
  // agent should run the corresponding action and report back via
  // POST /v1/nodes/:id/ssh-sessions/:requestId/status.
  sshSession?: SshSessionAction;
  // M3-T6: workspace checkpoint action. When present, the agent should
  // either tar+upload the buyer's workspace (action=checkpoint) or
  // download+untar a prior snapshot before the buyer connects
  // (action=restore). Reported back via /v1/agent/checkpoints (for
  // upload) or /v1/agent/checkpoints/restore-applied (for restore).
  workspaceCheckpoint?: WorkspaceCheckpointAction;
  // C4 wave 1: workspace benchmark action. When present, the agent
  // pulls the benchmark image, runs it with --gpus all, parses the
  // JSON output, and reports back via /v1/agent/benchmark/result.
  benchmark?: BenchmarkAction;
}

/**
 * One pending SSH lifecycle action surfaced by the API. The agent
 * acts on it once per request id and reports the resulting status
 * back; subsequent heartbeats will not re-emit the same action.
 */
export type SshSessionAction =
  | {
      action: 'provision';
      requestId: string;
      username: string;
      pubKey?: string;
    }
  | {
      action: 'terminate';
      requestId: string;
      username: string;
    };

/**
 * Agent → API callback payload for /v1/nodes/:id/ssh-sessions/:requestId/status.
 */
export interface SshSessionStatusUpdate {
  status: 'PROVISIONING' | 'ACTIVE' | 'TERMINATED' | 'FAILED';
  errorMessage?: string;
}

/**
 * M3-T6: workspace checkpoint action surfaced by the heartbeat
 * response. The agent runs the action against the buyer's per-rental
 * workspace (canonically /home/{username}) and reports back via the
 * appropriate callback endpoint.
 */
export type WorkspaceCheckpointAction =
  | {
      action: 'checkpoint';
      requestId: string;
      username: string;
      checkpointId: string; // 'pending' until the agent allocates one
    }
  | {
      action: 'restore';
      requestId: string;
      username: string;
      checkpointId: string; // points at a prior rental's snapshot
    };

/**
 * Agent → API callback payload for POST /v1/agent/checkpoints when
 * the upload completes (or fails). On READY the agent must include
 * bucketUrl + checkpointId so the row is updated atomically.
 */
export interface CheckpointStatusUpdate {
  computeRequestId: string;
  status: 'UPLOADING' | 'READY' | 'FAILED';
  bucketUrl?: string;
  checkpointId?: string;
  error?: string;
}

/**
 * C4 wave 1: workspace benchmark action surfaced on the heartbeat
 * response when the operator has triggered "Run Benchmark" on the
 * portal. The agent pulls the configured benchmark image, runs it
 * with --gpus all, parses the JSON line of output, and reports back
 * via POST /v1/agent/benchmark/result. Fire-and-forget from the
 * heartbeat's perspective; per-node dedupe lives in the benchmark
 * manager so repeated heartbeat dispatches while in-flight no-op.
 */
export interface BenchmarkAction {
  action: 'run';
  // Image override (e.g. for staging environments). Falls back to the
  // agent's default if missing.
  image?: string;
}

/**
 * Agent → API callback payload for POST /v1/agent/benchmark/result.
 * Success path includes the 3 metric fields; failure path includes
 * only `error` and the row's lastBenchmarkAt is set to now() so the
 * UI knows the run completed (just badly).
 */
export interface BenchmarkResultUpdate {
  matmulTflops?: number;
  vramBandwidthGbs?: number;
  score?: number;
  gpuName?: string;
  error?: string;
}

/**
 * Node Commands from server
 */
export interface NodeCommand {
  id: string;
  type: 'PAUSE' | 'RESUME' | 'RESTART' | 'UPDATE' | 'DRAIN' | 'UNINSTALL';
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
  agentVersion: string;
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
