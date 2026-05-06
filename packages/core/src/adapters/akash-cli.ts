/**
 * Akash CLI shellout helpers.
 *
 * The chain-sdk's typed proto encoders for Deposit went out of sync with
 * mainnet validation (alpha SDK + chain upgrade). Rather than guess proto
 * shapes, we shell out to the official `akash` CLI for the transactional
 * lifecycle steps (deployment create / lease create / deployment close).
 * The CLI is the canonical reference implementation, exercised by every
 * Akash user, and is immune to proto-drift between minor chain upgrades.
 *
 * The CLI binary is installed at /usr/local/bin/akash on the production LXC
 * (override via AKASH_CLI_PATH). The wallet mnemonic is imported into the
 * akash keyring under key name `a2e` (override via AKASH_KEY_NAME), backend
 * "test" (passwordless, file-based — acceptable for our rotation model).
 *
 * Read-only queries continue to go through Akash REST (akash-rest.ts).
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_CLI = '/usr/local/bin/akash'
const DEFAULT_KEY_NAME = 'a2e'
const DEFAULT_NODE_RPC = 'https://rpc.akashnet.net:443'
const DEFAULT_CHAIN_ID = 'akashnet-2'
const DEFAULT_GAS_PRICES = '0.025uakt'
const DEFAULT_FEES = '5000uakt'

export interface CliOptions {
  cliPath?: string
  keyName?: string
  nodeRpc?: string
  chainId?: string
  gasPrices?: string
  fees?: string
}

interface CliResult {
  stdout: string
  stderr: string
  code: number
}

function getCli(options: CliOptions = {}): string {
  return options.cliPath ?? process.env.AKASH_CLI_PATH ?? DEFAULT_CLI
}

function getKeyName(options: CliOptions = {}): string {
  return options.keyName ?? process.env.AKASH_KEY_NAME ?? DEFAULT_KEY_NAME
}

function getCommonFlags(options: CliOptions = {}): string[] {
  // The akash CLI rejects --gas-prices + --fees together. We pick a fixed
  // --fees that's plenty for a single tx (~$0.003) and let auto-gas estimate
  // the gas amount itself.
  return [
    '--node', options.nodeRpc ?? process.env.AKASH_RPC_URL ?? DEFAULT_NODE_RPC,
    '--chain-id', options.chainId ?? process.env.AKASH_CHAIN_ID ?? DEFAULT_CHAIN_ID,
    '--keyring-backend', 'test',
    '--from', getKeyName(options),
    '--gas', 'auto',
    '--gas-adjustment', '1.5',
    '--fees', options.fees ?? DEFAULT_FEES,
    '-y',
    '-o', 'json',
  ]
}

async function runCli(args: string[], options: CliOptions & { timeoutMs?: number } = {}): Promise<CliResult> {
  const cli = getCli(options)
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { env: { ...process.env, AKASH_KEYRING_BACKEND: 'test' } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`akash CLI timeout after ${options.timeoutMs ?? 90000}ms`))
    }, options.timeoutMs ?? 90_000)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

interface TxOutput {
  txhash?: string
  code?: number
  raw_log?: string
  logs?: Array<{ events?: Array<{ type?: string; attributes?: Array<{ key?: string; value?: string }> }> }>
}

function parseJson(output: string): TxOutput {
  // CLI sometimes prints warnings before JSON. Find the first { and parse from there.
  const first = output.indexOf('{')
  if (first < 0) throw new Error(`No JSON found in CLI output: ${output.slice(0, 300)}`)
  return JSON.parse(output.slice(first)) as TxOutput
}

/**
 * Submit MsgCreateDeployment via the CLI. Writes the SDL YAML to a temp file
 * (CLI takes a path), executes, parses the resulting tx hash. Returns the
 * dseq extracted from the tx events.
 */
export async function cliCreateDeployment(
  sdlYaml: string,
  depositUakt: bigint,
  options: CliOptions = {}
): Promise<{ txHash: string; dseq: bigint }> {
  const tmp = await mkdtemp(join(tmpdir(), 'a2e-akash-sdl-'))
  const sdlPath = join(tmp, 'deploy.yaml')
  try {
    await writeFile(sdlPath, sdlYaml, 'utf-8')

    const result = await runCli(
      ['tx', 'deployment', 'create', sdlPath, '--deposit', `${depositUakt}uakt`, ...getCommonFlags(options)],
      { timeoutMs: 120_000 }
    )

    if (result.code !== 0 && !result.stdout.includes('"code":')) {
      throw new Error(`akash deployment create failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`)
    }

    const tx = parseJson(result.stdout)
    if (tx.code !== 0) {
      throw new Error(`akash tx rejected: code=${tx.code} log=${(tx.raw_log ?? '').slice(0, 400)}`)
    }
    if (!tx.txhash) {
      throw new Error('akash CLI produced no txhash')
    }

    const dseq = extractEventAttribute(tx, 'akash.v1.EventDeploymentCreated', 'dseq')
      ?? extractEventAttribute(tx, 'akash.deployment.v1beta4.EventDeploymentCreated', 'dseq')
    if (!dseq) {
      throw new Error(`akash CLI: dseq not found in tx events. txhash=${tx.txhash}`)
    }
    return { txHash: tx.txhash, dseq: BigInt(dseq) }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

export async function cliCreateLease(
  bidId: { dseq: bigint; gseq: number; oseq: number; provider: string },
  options: CliOptions = {}
): Promise<{ txHash: string }> {
  const result = await runCli(
    [
      'tx', 'market', 'lease', 'create',
      '--dseq', bidId.dseq.toString(),
      '--gseq', String(bidId.gseq),
      '--oseq', String(bidId.oseq),
      '--provider', bidId.provider,
      ...getCommonFlags(options),
    ],
    { timeoutMs: 90_000 }
  )

  if (result.code !== 0 && !result.stdout.includes('"code":')) {
    throw new Error(`akash lease create failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`)
  }
  const tx = parseJson(result.stdout)
  if (tx.code !== 0) {
    throw new Error(`akash lease create rejected: code=${tx.code} log=${(tx.raw_log ?? '').slice(0, 400)}`)
  }
  return { txHash: tx.txhash ?? '' }
}

export async function cliCloseDeployment(
  dseq: bigint,
  options: CliOptions = {}
): Promise<{ txHash: string }> {
  const result = await runCli(
    [
      'tx', 'deployment', 'close',
      '--dseq', dseq.toString(),
      ...getCommonFlags(options),
    ],
    { timeoutMs: 90_000 }
  )

  if (result.code !== 0 && !result.stdout.includes('"code":')) {
    // Some "already closed" errors come back via stderr; treat them as idempotent success.
    if (/already.*closed|deployment.*closed/i.test(result.stderr)) {
      return { txHash: '' }
    }
    throw new Error(`akash deployment close failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`)
  }
  const tx = parseJson(result.stdout)
  if (tx.code !== 0 && !/already.*closed/i.test(tx.raw_log ?? '')) {
    throw new Error(`akash deployment close rejected: code=${tx.code} log=${(tx.raw_log ?? '').slice(0, 400)}`)
  }
  return { txHash: tx.txhash ?? '' }
}

function extractEventAttribute(tx: TxOutput, eventType: string, key: string): string | undefined {
  for (const log of tx.logs ?? []) {
    for (const event of log.events ?? []) {
      if (event.type === eventType) {
        for (const attr of event.attributes ?? []) {
          if (attr.key === key && attr.value) return attr.value
        }
      }
    }
  }
  return undefined
}
