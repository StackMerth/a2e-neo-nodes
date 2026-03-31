import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { logger } from './utils/logger.js';

/**
 * Configuration schema using Zod for validation
 */
const ServerConfigSchema = z.object({
  apiUrl: z.string().url('Invalid API URL'),
  apiKey: z.string().min(1, 'API key is required'),
  wsUrl: z.string().url('Invalid WebSocket URL').optional(),
});

const AgentConfigSchema = z.object({
  nodeId: z.string().nullable().default(null),
  name: z.string().default('GPU Node'),
  heartbeatInterval: z.number().min(10).max(300).default(30),
  jobPollInterval: z.number().min(5).max(60).default(10),
});

const GpuConfigSchema = z.object({
  autoDetect: z.boolean().default(true),
  tier: z.enum(['H100', 'H200', 'B200', 'B300', 'GB300', 'OTHER']).nullable().default(null),
  devices: z.array(z.number()).nullable().default(null),
  // Mock mode for testing without real GPU
  mockGpu: z.boolean().default(false),
  mockModel: z.string().default('NVIDIA H100 80GB HBM3 (Mock)'),
  mockVram: z.number().default(81920), // 80GB in MB
});

const DockerConfigSchema = z.object({
  socketPath: z.string().default('/var/run/docker.sock'),
  gpuRuntime: z.string().default('nvidia'),
  defaultTimeout: z.number().min(60).max(86400).default(3600),
  maxConcurrentJobs: z.number().min(1).max(8).default(1),
  pullTimeout: z.number().min(60).max(3600).default(600),
  trustedRegistries: z.array(z.string()).default([]),
});

const ResourcesConfigSchema = z.object({
  maxMemory: z.string().nullable().default(null),
  maxCpus: z.number().nullable().default(null),
  maxDiskSpace: z.number().default(100),
});

const LoggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  file: z.string().nullable().default(null),
  pretty: z.boolean().default(false),
  maxSize: z.number().default(100),
  maxFiles: z.number().default(7),
});

const RecoveryConfigSchema = z.object({
  stateFile: z.string().default('/var/lib/a2e-agent/state.json'),
  enableCheckpoints: z.boolean().default(true),
  maxReconnectAttempts: z.number().default(10),
  reconnectDelay: z.number().default(1000),
});

const SecurityConfigSchema = z.object({
  restrictCapabilities: z.boolean().default(true),
  readOnlyRootfs: z.boolean().default(true),
  dropCapabilities: z.boolean().default(true),
  userNamespace: z.boolean().default(false),
});

const ConfigSchema = z.object({
  server: ServerConfigSchema,
  agent: AgentConfigSchema.default({}),
  gpu: GpuConfigSchema.default({}),
  docker: DockerConfigSchema.default({}),
  resources: ResourcesConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  recovery: RecoveryConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type GpuConfig = z.infer<typeof GpuConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type RecoveryConfig = z.infer<typeof RecoveryConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

/**
 * Default configuration file paths to search
 */
const DEFAULT_CONFIG_PATHS = [
  '/etc/a2e-agent/config.yaml',
  '/etc/a2e-agent/config.yml',
  path.join(process.cwd(), 'config.yaml'),
  path.join(process.cwd(), 'config.yml'),
];

/**
 * Interpolate environment variables in string values
 * Supports ${VAR_NAME} syntax
 */
function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
      const envValue = process.env[envVar];
      if (envValue === undefined) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }
  return value;
}

/**
 * Load configuration from file
 */
function loadConfigFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.parse(content) as Record<string, unknown>;

  return interpolateEnvVars(parsed) as Record<string, unknown>;
}

/**
 * Find configuration file in default paths
 */
function findConfigFile(): string | null {
  for (const configPath of DEFAULT_CONFIG_PATHS) {
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

/**
 * Merge configuration from environment variables
 */
function mergeEnvConfig(config: Record<string, unknown>): Record<string, unknown> {
  const envMapping: Record<string, string[]> = {
    A2E_API_URL: ['server', 'apiUrl'],
    A2E_API_KEY: ['server', 'apiKey'],
    A2E_WS_URL: ['server', 'wsUrl'],
    A2E_NODE_ID: ['agent', 'nodeId'],
    A2E_NODE_NAME: ['agent', 'name'],
    A2E_HEARTBEAT_INTERVAL: ['agent', 'heartbeatInterval'],
    A2E_JOB_POLL_INTERVAL: ['agent', 'jobPollInterval'],
    A2E_GPU_TIER: ['gpu', 'tier'],
    A2E_MOCK_GPU: ['gpu', 'mockGpu'],
    A2E_DOCKER_SOCKET: ['docker', 'socketPath'],
    A2E_LOG_LEVEL: ['logging', 'level'],
    A2E_LOG_FILE: ['logging', 'file'],
    A2E_STATE_FILE: ['recovery', 'stateFile'],
  };

  const result = { ...config };

  for (const [envVar, path] of Object.entries(envMapping)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      let current: Record<string, unknown> = result;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (key === undefined) { continue; }
        if (current[key] === undefined) {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }
      const lastKey = path[path.length - 1];
      if (lastKey !== undefined) {
        // Convert numeric values
        if (['heartbeatInterval', 'jobPollInterval'].includes(lastKey)) {
          current[lastKey] = parseInt(value, 10);
        } else if (['mockGpu'].includes(lastKey)) {
          // Convert boolean values
          current[lastKey] = value === 'true' || value === '1';
        } else {
          current[lastKey] = value;
        }
      }
    }
  }

  return result;
}

/**
 * Command line arguments interface
 */
export interface CliArgs {
  config?: string;
  apiUrl?: string;
  apiKey?: string;
  nodeId?: string;
  logLevel?: string;
}

/**
 * Merge command line arguments into configuration
 */
function mergeCliConfig(config: Record<string, unknown>, args: CliArgs): Record<string, unknown> {
  const result = { ...config };

  if (args.apiUrl) {
    (result.server as Record<string, unknown>).apiUrl = args.apiUrl;
  }
  if (args.apiKey) {
    (result.server as Record<string, unknown>).apiKey = args.apiKey;
  }
  if (args.nodeId) {
    (result.agent as Record<string, unknown>).nodeId = args.nodeId;
  }
  if (args.logLevel) {
    (result.logging as Record<string, unknown>).level = args.logLevel;
  }

  return result;
}

/**
 * Validate Docker socket accessibility
 */
function validateDockerSocket(socketPath: string): void {
  if (!fs.existsSync(socketPath)) {
    throw new Error(`Docker socket not found at ${socketPath}. Is Docker running?`);
  }

  try {
    fs.accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot access Docker socket at ${socketPath}. Check permissions.`);
  }
}

/**
 * Load and validate configuration
 */
export function loadConfig(args: CliArgs = {}): Config {
  // Determine config file path
  let configPath = args.config;
  if (!configPath) {
    configPath = findConfigFile() ?? undefined;
  }

  // Start with empty config or load from file
  let rawConfig: Record<string, unknown> = {
    server: {},
    agent: {},
    gpu: {},
    docker: {},
    resources: {},
    logging: {},
    recovery: {},
    security: {},
  };

  if (configPath) {
    try {
      rawConfig = loadConfigFile(configPath);
      logger.info({ configPath }, 'Loaded configuration from file');
    } catch (error) {
      logger.error({ error, configPath }, 'Failed to load configuration file');
      throw error;
    }
  }

  // Merge environment variables (higher priority)
  rawConfig = mergeEnvConfig(rawConfig);

  // Merge CLI arguments (highest priority)
  rawConfig = mergeCliConfig(rawConfig, args);

  // Validate configuration
  const result = ConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  const config = result.data;

  // Additional runtime validations (skip Docker check in mock mode)
  if (!config.gpu.mockGpu) {
    validateDockerSocket(config.docker.socketPath);
  } else {
    logger.warn('Mock GPU mode enabled - Docker validation skipped');
  }

  return config;
}

/**
 * Global configuration instance
 */
let globalConfig: Config | null = null;

/**
 * Initialize global configuration
 */
export function initConfig(args: CliArgs = {}): Config {
  globalConfig = loadConfig(args);
  return globalConfig;
}

/**
 * Get global configuration (must be initialized first)
 */
export function getConfig(): Config {
  if (!globalConfig) {
    throw new Error('Configuration not initialized. Call initConfig() first.');
  }
  return globalConfig;
}

/**
 * Update node ID in configuration (after registration)
 */
export function setNodeId(nodeId: string): void {
  if (!globalConfig) {
    throw new Error('Configuration not initialized');
  }
  globalConfig.agent.nodeId = nodeId;
}
