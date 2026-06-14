/**
 * ETH + ZKC -> USDC swap rail.
 *
 * Two earnings tokens land in our platform wallet on Base:
 *   - ETH (per-order fees, paid immediately on each fulfill)
 *   - ZKC (PoVW emissions, claimed manually each ~48h epoch)
 *
 * Both need to be converted to USDC to credit the operator's USD
 * ledger. We do the swap "at accrual" (the moment the token hits our
 * wallet) so the operator's earned USD value is locked at the spot
 * rate at acceptance time. This eliminates the alternative of holding
 * volatile tokens in custody on the operator's behalf.
 *
 * Status: SKELETON. Interface defined; the actual Uniswap V3 router
 * call is gated behind UBI_BOUNDLESS_ENABLED. M2.6b adds viem + the
 * SwapRouter02 ABI. The simulator stands in by returning placeholder
 * USDC quotes against fixed prices.
 *
 * Architecture:
 *   - ETH -> USDC: single Uniswap V3 pool on Base (high liquidity,
 *     0.05% fee tier)
 *   - ZKC -> USDC: two-hop via WETH (ZKC/WETH then WETH/USDC). Low
 *     ZKC liquidity early may require larger slippage tolerance;
 *     M2.6b adds a guard that aborts the swap if slippage > 5%.
 *
 * Slippage policy:
 *   - Default tolerance: 1.0%
 *   - Hard abort: 5.0% (operator wallet gets credited with the
 *     spot-quote anyway; platform eats the slippage as ops cost)
 *
 * Risk: thin ZKC liquidity in early epochs could fail swaps. M5
 * (ops + monitoring) wires an alert + a "skip swap, hold ZKC for
 * 24h" fallback that retries later.
 */

import type { PrismaClient } from '@a2e/database'

export type SwapToken = 'ETH' | 'ZKC'

export interface SwapQuote {
  inputToken: SwapToken
  inputAmountAtto: string // raw token amount, atto-scale (18 decimals)
  outputUsdc: number // expected USDC (6 decimals) as a float for display
  priceImpactPct: number // 0-100; abort if above HARD_SLIPPAGE_PCT
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
  // Our platform wallet on Base; holds ETH + ZKC and pays for the
  // swap gas. M2.1 funds this address before any of M2.5/M2.6 can
  // run for real.
  platformWalletAddress: string
}

const ENABLED = process.env.UBI_BOUNDLESS_ENABLED === 'true'

const DEFAULT_SLIPPAGE_PCT = 1.0
const HARD_SLIPPAGE_PCT = 5.0

/**
 * Quote an input amount of ETH or ZKC to USDC. Skeleton returns a
 * placeholder quote based on fixed prices; the live wiring calls
 * the Uniswap V3 Quoter contract on Base.
 */
export async function quoteSwap(
  inputToken: SwapToken,
  inputAmountAtto: string,
): Promise<SwapQuote> {
  if (!ENABLED) {
    return placeholderQuote(inputToken, inputAmountAtto)
  }
  // M2.6b: call Uniswap V3 QuoterV2 quoteExactInputSingle for ETH/USDC
  // and a multi-hop quoteExactInput for ZKC/WETH/USDC. Return both the
  // expected output and the spot price impact.
  return placeholderQuote(inputToken, inputAmountAtto)
}

/**
 * Execute a swap and credit the platform USDC balance. Skeleton just
 * returns the placeholder quote; live wiring submits a transaction
 * via the Uniswap V3 SwapRouter02 and waits for confirmation.
 *
 * Idempotent on (caller-supplied) referenceId; if a swap with the
 * same referenceId already landed, returns the cached result.
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

  // M2.6b: build SwapRouter02 exactInputSingle (ETH) or exactInput
  // (ZKC multi-hop), submit, wait for receipt, parse USDC received.
  throw new Error('Swap rail not yet wired (M2.6b task)')
}

export class SwapAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwapAbortedError'
  }
}

function placeholderQuote(
  inputToken: SwapToken,
  inputAmountAtto: string,
): SwapQuote {
  // Fixed placeholder prices for skeleton. Real prices come from
  // Uniswap quoter (M2.6b) or oracle (Pyth / Chainlink fallback).
  const PLACEHOLDER_PRICE_USDC: Record<SwapToken, number> = {
    ETH: 3500,
    ZKC: 0.5, // coarse; ZKC has thin liquidity early
  }
  const inputUnits = Number(inputAmountAtto) / 1e18
  const outputUsdc = Math.round(inputUnits * PLACEHOLDER_PRICE_USDC[inputToken] * 1e6) / 1e6
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
}
