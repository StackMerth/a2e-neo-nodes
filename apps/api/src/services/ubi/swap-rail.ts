/**
 * ETH + ZKC -> USDC swap rail (M2.6b live wiring).
 *
 * Two earnings tokens land in our platform wallet on Base:
 *   - ETH (per-order fees, paid immediately on each fulfill)
 *   - ZKC (PoVW emissions, claimed manually each ~48h epoch)
 *
 * Both need to be converted to USDC to credit the operator's USD
 * ledger. We do the swap "at accrual" (the moment the token hits
 * our wallet) so the operator's earned USD value is locked at the
 * spot rate at acceptance time. This eliminates the alternative of
 * holding volatile tokens in custody on the operator's behalf.
 *
 * Status: M2.6b live wiring. Gated behind UBI_BOUNDLESS_ENABLED so
 * production stays a no-op until M2.1 funds and M2.2 deploys the
 * broker. Quote calls are free (read-only mainnet); execution calls
 * need the platform wallet private key (loaded from BOUNDLESS_-
 * PLATFORM_PK env, set as part of M2.1).
 *
 * Architecture realities (per memory/zk_ubi_base_contracts_2026_06_14.md):
 *   - ETH -> USDC: viable via Uniswap V3 (high liquidity, single
 *     hop). Implemented here.
 *   - ZKC -> USDC: NOT viable via Uniswap V3 on Base today (only V3
 *     pool is 1% fee ZKC/USDC with ~$36 TVL). Real ZKC liquidity is
 *     on CEXs (~$13.9M/24h on Binance + Coinbase + others). This
 *     adapter throws ZkcSwapNotSupportedError; M5 ops adds either
 *     a 1inch / 0x aggregator or a CEX off-ramp.
 *
 * Slippage policy:
 *   - Default tolerance: 1.0%
 *   - Hard abort: 5.0% (we eat platform-side, never credit operator
 *     less than the spot-quoted amount)
 */

import type { PrismaClient } from '@a2e/database'
import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  parseUnits,
} from 'viem'
import { base } from 'viem/chains'

export type SwapToken = 'ETH' | 'ZKC'

export interface SwapQuote {
  inputToken: SwapToken
  inputAmountAtto: string
  outputUsdc: number
  priceImpactPct: number
  quotedAt: Date
}

export interface SwapResult {
  inputToken: SwapToken
  inputAmountAtto: string
  outputUsdcReceived: number
  txHash: string
  executedAt: Date
}

export interface SwapRailDeps {
  prisma: PrismaClient
  platformWalletAddress: string
}

const ENABLED = process.env.UBI_BOUNDLESS_ENABLED === 'true'

export class SwapAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwapAbortedError'
  }
}

export class ZkcSwapNotSupportedError extends Error {
  constructor() {
    super(
      'ZKC -> USDC swap is not supported via Uniswap V3 on Base today ' +
        '(thin liquidity, ~$36 TVL). Wire 1inch / 0x aggregator or ' +
        'CEX off-ramp in M5 ops. Until then, ZKC accrues to platform ' +
        'wallet and converts to USDC manually.',
    )
    this.name = 'ZkcSwapNotSupportedError'
  }
}

const DEFAULT_SLIPPAGE_PCT = 1.0
const HARD_SLIPPAGE_PCT = 5.0

// Base mainnet — confirmed against Uniswap V3 base-deployments docs
// and memory/zk_ubi_base_contracts_2026_06_14.md
const BASE = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
  WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
  QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as `0x${string}`,
  SWAP_ROUTER_02: '0x2626664c2603336E57B271c5C0b26F421741e481' as `0x${string}`,
}

// USDC on Base has 6 decimals
const USDC_DECIMALS = 6
// WETH / ETH wei
const ETH_DECIMALS = 18

// Standard Uniswap V3 ETH/USDC pool fee tier on Base.
// 500 = 0.05% — the most-traded ETH/USDC pool
const ETH_USDC_FEE_TIER = 500

const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

const SWAP_ROUTER_02_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
])

function getBaseClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL),
  })
}

/**
 * Quote a token amount to USDC. ETH path is live (calls QuoterV2 on
 * Base mainnet — free read). ZKC path throws ZkcSwapNotSupportedError.
 */
export async function quoteSwap(
  inputToken: SwapToken,
  inputAmountAtto: string,
): Promise<SwapQuote> {
  if (!ENABLED) {
    return placeholderQuote(inputToken, inputAmountAtto)
  }

  if (inputToken === 'ZKC') {
    throw new ZkcSwapNotSupportedError()
  }

  // ETH path: simulateContract against QuoterV2's quoteExactInputSingle.
  // The function is non-view in the ABI but Uniswap implements it as a
  // staticcall-friendly stub; viem's simulateContract handles this.
  const client = getBaseClient()
  const inputWei = BigInt(inputAmountAtto)

  const result = await client.simulateContract({
    address: BASE.QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: BASE.WETH,
        tokenOut: BASE.USDC,
        amountIn: inputWei,
        fee: ETH_USDC_FEE_TIER,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })

  const amountOut: bigint = result.result[0]
  const outputUsdc = Number(formatUnits(amountOut, USDC_DECIMALS))

  // Spot price impact estimation: compare against a tiny-amount quote
  // (1e15 wei = 0.001 ETH) to derive marginal price, then compare to
  // the requested amount's effective price.
  const tinyAmount = parseUnits('0.001', ETH_DECIMALS)
  const tinyResult = await client.simulateContract({
    address: BASE.QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: BASE.WETH,
        tokenOut: BASE.USDC,
        amountIn: tinyAmount,
        fee: ETH_USDC_FEE_TIER,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  const tinyOut: bigint = tinyResult.result[0]
  const tinyUsdPerEth = Number(formatUnits(tinyOut, USDC_DECIMALS)) / 0.001
  const actualUsdPerEth =
    outputUsdc / Number(formatUnits(inputWei, ETH_DECIMALS))
  const priceImpactPct = tinyUsdPerEth > 0
    ? Math.max(0, ((tinyUsdPerEth - actualUsdPerEth) / tinyUsdPerEth) * 100)
    : 0

  return {
    inputToken,
    inputAmountAtto,
    outputUsdc,
    priceImpactPct,
    quotedAt: new Date(),
  }
}

/**
 * Execute a swap and credit the platform USDC balance. ETH path
 * requires the platform wallet private key (BOUNDLESS_PLATFORM_PK
 * env). ZKC path throws ZkcSwapNotSupportedError.
 *
 * Idempotency: caller passes a referenceId; this function doesn't
 * persist its own dedup record (M4 wires that into the UbiProof row).
 * Callers should check for an existing UbiProof.acceptedAt before
 * triggering a swap to avoid double-execution.
 */
export async function executeSwap(
  _deps: SwapRailDeps,
  inputToken: SwapToken,
  inputAmountAtto: string,
  _referenceId: string,
): Promise<SwapResult> {
  const quote = await quoteSwap(inputToken, inputAmountAtto)

  if (quote.priceImpactPct > HARD_SLIPPAGE_PCT) {
    throw new SwapAbortedError(
      `Price impact ${quote.priceImpactPct.toFixed(2)}% exceeds hard limit ${HARD_SLIPPAGE_PCT}%`,
    )
  }

  if (!ENABLED) {
    return {
      inputToken,
      inputAmountAtto,
      outputUsdcReceived: quote.outputUsdc,
      txHash: `simulated-swap-${Date.now()}`,
      executedAt: new Date(),
    }
  }

  if (inputToken === 'ZKC') {
    throw new ZkcSwapNotSupportedError()
  }

  // M4 wiring: build SwapRouter02 exactInputSingle tx, sign with
  // BOUNDLESS_PLATFORM_PK, broadcast, wait for receipt, parse USDC
  // received.
  //
  // Why this is intentionally left as an error throw and not a
  // sweet implementation: the platform wallet private key isn't set
  // until M2.1 funds the wallet. Leaving an unimplemented signed-
  // execution path encourages "looks-done" deploys that 500 in
  // production at the wrong moment. The throw forces an explicit
  // M4 PR that pulls the key, builds the tx, and tests against
  // Base Sepolia first.
  throw new Error(
    'executeSwap ETH path requires platform wallet private key — wired in M4 once M2.1 funds',
  )
}

function placeholderQuote(
  inputToken: SwapToken,
  inputAmountAtto: string,
): SwapQuote {
  const PLACEHOLDER_PRICE_USDC: Record<SwapToken, number> = {
    ETH: 3500,
    ZKC: 0.5,
  }
  const inputUnits = Number(inputAmountAtto) / 1e18
  const outputUsdc =
    Math.round(inputUnits * PLACEHOLDER_PRICE_USDC[inputToken] * 1e6) / 1e6
  return {
    inputToken,
    inputAmountAtto,
    outputUsdc,
    priceImpactPct: 0,
    quotedAt: new Date(),
  }
}

export const SWAP_RAIL_CONFIG = {
  DEFAULT_SLIPPAGE_PCT,
  HARD_SLIPPAGE_PCT,
  ETH_USDC_FEE_TIER,
}

export const BASE_ADDRESSES = BASE

// Re-export the function name SWAP_ROUTER_02_ABI uses, in case the
// admin or M4 wires a different tx-builder.
export { SWAP_ROUTER_02_ABI }
