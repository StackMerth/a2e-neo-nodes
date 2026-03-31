import pino from 'pino';
import type { LoggingConfig } from '../config.js';

/**
 * Log levels supported by the agent
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Context fields for structured logging
 */
export interface LogContext {
  nodeId?: string;
  jobId?: string;
  component?: string;
  [key: string]: unknown;
}

/**
 * Create a child logger with additional context
 */
export function createChildLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}

/**
 * Default logger instance (before config is loaded)
 * Uses plain JSON logging - pino-pretty transport doesn't work in bundled builds
 */
let loggerInstance: pino.Logger = pino({
  level: 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Get the current logger instance
 */
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop: keyof pino.Logger) {
    return loggerInstance[prop];
  },
});

/**
 * Initialize logger with configuration
 */
export function initLogger(config: LoggingConfig, nodeId?: string): pino.Logger {
  const baseOptions: pino.LoggerOptions = {
    level: config.level,
    base: nodeId ? { nodeId } : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // Note: pino transports (pino-pretty, pino/file) don't work in bundled builds
  // because they use worker threads and dynamic requires.
  // We use plain JSON logging to stdout for all cases in the bundled agent.
  // File logging can be handled by systemd/journald redirecting stdout.
  loggerInstance = pino(baseOptions);

  return loggerInstance;
}

/**
 * Component-specific loggers
 */
export const agentLogger = (): pino.Logger => createChildLogger({ component: 'agent' });
export const heartbeatLogger = (): pino.Logger => createChildLogger({ component: 'heartbeat' });
export const gpuLogger = (): pino.Logger => createChildLogger({ component: 'gpu' });
export const dockerLogger = (): pino.Logger => createChildLogger({ component: 'docker' });
export const jobLogger = (): pino.Logger => createChildLogger({ component: 'job' });
export const apiLogger = (): pino.Logger => createChildLogger({ component: 'api' });
export const recoveryLogger = (): pino.Logger => createChildLogger({ component: 'recovery' });
export const securityLogger = (): pino.Logger => createChildLogger({ component: 'security' });
