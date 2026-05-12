#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { Agent } from './agent.js';
import { initConfig, type CliArgs } from './config.js';
import { initLogger, logger } from './utils/logger.js';
import { initApiClient } from './api/client.js';

/**
 * Agent version
 */
const VERSION = process.env.AGENT_VERSION ?? '1.0.0';

/**
 * Parse command line arguments
 */
function parseArgs(): { args: CliArgs; command?: string; outputPath?: string } {
  const args: CliArgs = {};
  const argv = process.argv.slice(2);
  let command: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const nextArg = argv[i + 1];

    switch (arg) {
      case 'configure':
        command = 'configure';
        break;
      case '--output':
      case '-o':
        outputPath = nextArg;
        i++;
        break;
      case '--config':
      case '-c':
        args.config = nextArg;
        i++;
        break;
      case '--api-url':
        args.apiUrl = nextArg;
        i++;
        break;
      case '--api-key':
        args.apiKey = nextArg;
        i++;
        break;
      case '--node-id':
        args.nodeId = nextArg;
        i++;
        break;
      case '--log-level':
        args.logLevel = nextArg;
        i++;
        break;
      case '--version':
      case '-v':
        console.log(`A²E Node Agent v${VERSION}`);
        process.exit(0);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  return { args, command, outputPath };
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
A²E Node Agent v${VERSION}

Usage: a2e-agent [command] [options]

Commands:
  configure               Run interactive configuration wizard
  (none)                  Start the agent

Options:
  -c, --config <path>     Path to configuration file
  -o, --output <path>     Output path for configure command
  --api-url <url>         A²E API URL
  --api-key <key>         API key for authentication
  --node-id <id>          Node ID (for re-registration)
  --log-level <level>     Log level (trace, debug, info, warn, error, fatal)
  -v, --version           Show version number
  -h, --help              Show this help message

Environment Variables:
  A2E_API_URL             A²E API URL
  A2E_API_KEY             API key for authentication
  A2E_NODE_ID             Node ID
  A2E_LOG_LEVEL           Log level

Configuration:
  The agent looks for configuration in:
    1. Path specified by --config
    2. /etc/a2e-agent/config.yaml
    3. ./config.yaml

Examples:
  # Start with default configuration
  a2e-agent

  # Start with custom config file
  a2e-agent --config /path/to/config.yaml

  # Run configuration wizard
  a2e-agent configure --output /etc/a2e-agent/agent.yaml

  # Start with environment variables
  A2E_API_URL=https://api.example.com A2E_API_KEY=xxx a2e-agent

Documentation:
  https://docs.tokenos.ai/a2e/node-agent
`);
}

/**
 * Prompt for user input
 */
async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const displayQuestion = defaultValue
      ? `${question} [${defaultValue}]: `
      : `${question}: `;

    rl.question(displayQuestion, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Detect GPU information
 */
function detectGpu(): { model: string; tier: string; count: number } {
  try {
    const output = execSync('nvidia-smi --query-gpu=name,count --format=csv,noheader', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = output.trim().split('\n');
    const model = lines[0]?.split(',')[0]?.trim() ?? 'Unknown';
    const count = lines.length;

    // Determine tier
    let tier = 'OTHER';
    if (model.includes('H100')) tier = 'H100';
    else if (model.includes('H200')) tier = 'H200';
    else if (model.includes('B200')) tier = 'B200';
    else if (model.includes('B300')) tier = 'B300';
    else if (model.includes('GB300')) tier = 'GB300';
    else if (model.includes('A100')) tier = 'A100';

    return { model, tier, count };
  } catch {
    return { model: 'Unknown', tier: 'UNKNOWN', count: 0 };
  }
}

/**
 * Run configuration wizard
 */
async function runConfigure(outputPath?: string): Promise<void> {
  console.log('\n=== A²E Node Agent Configuration Wizard ===\n');

  // API URL
  const apiUrl = await prompt('A²E API URL', 'https://tokenosdeai-api.onrender.com');

  // API Key
  const apiKey = await prompt('API Key');
  if (!apiKey) {
    console.error('Error: API key is required');
    process.exit(1);
  }

  // Node name
  const hostname = execSync('hostname', { encoding: 'utf-8' }).trim();
  const nodeName = await prompt('Node name', hostname);

  // GPU detection
  console.log('\nDetecting GPU...');
  const gpu = detectGpu();
  if (gpu.model !== 'Unknown') {
    console.log(`  Detected: ${gpu.model} (${gpu.count} GPU${gpu.count > 1 ? 's' : ''})`);
  } else {
    console.log('  No GPU detected');
  }

  const gpuTier = await prompt('GPU Tier', gpu.tier);

  // Heartbeat interval
  const heartbeatInterval = await prompt('Heartbeat interval (seconds)', '30');

  // Log level
  const logLevel = await prompt('Log level (trace, debug, info, warn, error)', 'info');

  // Generate configuration
  const config = `# A²E Node Agent Configuration
# Generated on ${new Date().toISOString()}

server:
  apiUrl: ${apiUrl}
  apiKey: ${apiKey}

node:
  name: ${nodeName}
  gpuTier: ${gpuTier}

docker:
  socketPath: /var/run/docker.sock
  gpuRuntime: nvidia

heartbeat:
  intervalSeconds: ${heartbeatInterval}

logging:
  level: ${logLevel}
  pretty: false

security:
  sandboxProfile: standard
  trustedRegistries:
    - docker.io
    - nvcr.io
    - gcr.io
    - ghcr.io
`;

  // Determine output path
  const finalPath = outputPath ?? './agent.yaml';

  // Create directory if needed
  const dir = path.dirname(finalPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write configuration
  fs.writeFileSync(finalPath, config, { encoding: 'utf-8', mode: 0o600 });
  console.log(`\nConfiguration saved to: ${finalPath}`);
  console.log('\nNext steps:');
  console.log(`  1. Review the configuration file`);
  console.log(`  2. Start the agent: a2e-agent --config ${finalPath}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Parse command line arguments
  const { args, command, outputPath } = parseArgs();

  // Handle configure command
  if (command === 'configure') {
    await runConfigure(outputPath);
    return;
  }

  // Load configuration
  let config;
  try {
    config = initConfig(args);
  } catch (error) {
    console.error('Failed to load configuration:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Initialize logger
  initLogger(config.logging);
  logger.info({ version: VERSION }, 'A²E Node Agent starting');

  // Initialize API client
  initApiClient(config.server);

  // Create and start agent
  const agent = new Agent(config);

  // Setup signal handlers
  let shuttingDown = false;

  const handleShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn('Shutdown already in progress, forcing exit');
      process.exit(1);
    }
    shuttingDown = true;

    logger.info({ signal }, 'Received shutdown signal');

    try {
      await agent.stop();
      logger.info('Agent stopped gracefully');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));

  // Handle SIGHUP for config reload (optional)
  process.on('SIGHUP', () => {
    logger.info('Received SIGHUP, reloading configuration');
    // TODO: Implement config reload
  });

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    void handleShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    void handleShutdown('unhandledRejection');
  });

  // Start the agent
  try {
    await agent.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start agent');
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
