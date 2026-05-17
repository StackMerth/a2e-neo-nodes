/**
 * C4 wave 1: workspace benchmark manager.
 *
 * Handles a single inbound action: pull the benchmark image, run it
 * with --gpus all, parse the JSON line of output, report results back
 * to the API. Mock mode (`BENCHMARK_MOCK_RESULT` env JSON string)
 * skips the Docker call entirely — useful for E2E testing the API +
 * UI without a GPU.
 *
 * Concurrency: at most one benchmark in flight per process. The API
 * heartbeat may surface the action multiple times (Config-flag based,
 * cleared on result callback); dedupe map blocks repeated dispatches
 * until the in-flight one completes.
 *
 * Failure handling: any error reports back as a BenchmarkResultUpdate
 * with `error` populated. The API row's lastBenchmarkAt is still
 * advanced so the operator UI shows "ran X minutes ago" with a clear
 * error message — preferable to silently never updating.
 */

import { spawn } from 'node:child_process'
import type { ApiClient } from '../api/client.js'
import type { BenchmarkAction, BenchmarkResultUpdate } from '../api/types.js'
import { recoveryLogger } from '../utils/logger.js'

const log = recoveryLogger()

const DEFAULT_IMAGE = process.env.BENCHMARK_IMAGE ?? 'ghcr.io/stackmerth/a2e-benchmark:latest'
const MAX_RUNTIME_MS = 10 * 60 * 1000 // 10 min hard ceiling (matmul + bandwidth = ~3 min on H100)

// Module-scoped flag — only one benchmark may run at a time on a node.
// Cleared on completion (success or failure) so the next heartbeat
// dispatch can kick off another run.
let inFlight = false

function runChild(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Parse the benchmark container's stdout. The image is contracted to
 * print a single JSON line with the result; we tolerate extra log
 * lines before/after by scanning for the last well-formed JSON object
 * that contains `score` or `error`.
 */
function parseResult(stdout: string): BenchmarkResultUpdate {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line) as BenchmarkResultUpdate
      if (parsed && (typeof parsed.score === 'number' || typeof parsed.error === 'string')) {
        return parsed
      }
    } catch {
      // try next line
    }
  }
  return { error: `Benchmark stdout did not contain a parseable result line. Raw output: ${stdout.slice(0, 400)}` }
}

/**
 * Mock-mode short-circuit. When `BENCHMARK_MOCK_RESULT` is set to a
 * JSON string, return it directly without invoking Docker. Lets the
 * UI + API + notification path be tested end-to-end without a GPU.
 */
function maybeMockResult(): BenchmarkResultUpdate | null {
  const raw = process.env.BENCHMARK_MOCK_RESULT
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as BenchmarkResultUpdate
    log.warn({ parsed }, 'Using BENCHMARK_MOCK_RESULT (not a real benchmark)')
    return parsed
  } catch (err) {
    log.error({ err, raw }, 'BENCHMARK_MOCK_RESULT is not valid JSON; ignoring')
    return null
  }
}

export async function handleBenchmark(
  api: ApiClient,
  action: BenchmarkAction,
): Promise<void> {
  if (inFlight) {
    log.debug('benchmark already in flight, skipping dispatch')
    return
  }
  inFlight = true

  try {
    const mock = maybeMockResult()
    if (mock) {
      await api.reportBenchmarkResult(mock)
      return
    }

    const image = action.image ?? DEFAULT_IMAGE
    log.info({ image }, 'Pulling benchmark image')

    // Pull is idempotent — Docker no-ops if the image is already cached
    // at the same digest. ~2 min worst case for a fresh pull on a slow
    // connection.
    const pull = await runChild('docker', ['pull', image], 5 * 60 * 1000)
    if (pull.code !== 0) {
      await api.reportBenchmarkResult({
        error: `docker pull failed (code ${pull.code}): ${pull.stderr.slice(0, 400)}`,
      })
      return
    }

    log.info({ image }, 'Running benchmark container')
    const run = await runChild(
      'docker',
      ['run', '--rm', '--gpus', 'all', image],
      MAX_RUNTIME_MS,
    )

    if (run.code !== 0) {
      await api.reportBenchmarkResult({
        error: `docker run exited ${run.code}: ${run.stderr.slice(0, 400)}`,
      })
      return
    }

    const result = parseResult(run.stdout)
    log.info(
      { score: result.score, matmul: result.matmulTflops, bw: result.vramBandwidthGbs },
      'Benchmark completed',
    )
    await api.reportBenchmarkResult(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ error: msg }, 'Benchmark dispatch failed')
    try {
      await api.reportBenchmarkResult({ error: msg })
    } catch (reportErr) {
      log.error({ error: reportErr }, 'Failed to report benchmark failure')
    }
  } finally {
    inFlight = false
  }
}
