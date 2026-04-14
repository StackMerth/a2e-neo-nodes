import * as http from 'http';
import type { Agent } from '../agent.js';
import { agentLogger } from '../utils/logger.js';

const log = agentLogger();

/**
 * Health Check Server - Exposes a local HTTP endpoint for health monitoring
 */
export class HealthServer {
  private readonly agent: Agent;
  private readonly port: number;
  private readonly host: string;
  private server: http.Server | null = null;

  constructor(agent: Agent, port: number = 9090, host: string = '127.0.0.1') {
    this.agent = agent;
    this.port = port;
    this.host = host;
  }

  /**
   * Start the health check server
   */
  start(): void {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        this.handleHealthCheck(res);
      } else if (req.method === 'GET' && req.url === '/ready') {
        this.handleReadyCheck(res);
      } else if (req.method === 'GET' && req.url === '/status') {
        this.handleStatus(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.listen(this.port, this.host, () => {
      log.info({ port: this.port, host: this.host }, 'Health check server started');
    });

    this.server.on('error', (err) => {
      log.warn({ error: err.message }, 'Health check server error');
    });
  }

  /**
   * Stop the health check server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        log.info('Health check server stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Liveness check - is the agent process alive?
   */
  private handleHealthCheck(res: http.ServerResponse): void {
    const state = this.agent.getState();
    const healthy = state !== 'ERROR';
    const statusCode = healthy ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: healthy ? 'healthy' : 'unhealthy',
      state,
      uptime: this.agent.getUptime(),
      timestamp: new Date().toISOString(),
    }));
  }

  /**
   * Readiness check - is the agent ready to accept jobs?
   */
  private handleReadyCheck(res: http.ServerResponse): void {
    const state = this.agent.getState();
    const ready = state === 'ONLINE' || state === 'BUSY';
    const statusCode = ready ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ready,
      state,
    }));
  }

  /**
   * Full status - detailed agent information
   */
  private handleStatus(res: http.ServerResponse): void {
    const status = this.agent.getStatus();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }
}
