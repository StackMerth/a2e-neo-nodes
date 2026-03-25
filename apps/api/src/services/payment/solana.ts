import type { PrismaClient } from '@a2e/database'

export interface PaymentResult {
  success: boolean
  txHash?: string
  error?: string
}

export interface SolanaConfig {
  rpcUrl: string
  payerPrivateKey: string
  usdcMint?: string
}

export async function getSolanaConfig(prisma: PrismaClient): Promise<SolanaConfig | null> {
  const config = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
  })

  if (!config?.solanaRpcUrl || !config?.payerPrivateKey) {
    return null
  }

  return {
    rpcUrl: config.solanaRpcUrl,
    payerPrivateKey: config.payerPrivateKey,
    usdcMint: config.usdcMint ?? undefined,
  }
}

export async function processPayment(
  config: SolanaConfig,
  recipientAddress: string,
  amountUsd: number,
  currency: 'SOL' | 'USDC' = 'USDC'
): Promise<PaymentResult> {
  try {
    console.log(
      `[Payment] Processing ${currency} payment of $${amountUsd} to ${recipientAddress}`
    )

    return {
      success: false,
      error: 'Solana payment integration pending - use manual settlement for now',
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown payment error',
    }
  }
}

export async function verifyTransaction(
  config: SolanaConfig,
  txHash: string
): Promise<{
  verified: boolean
  confirmations: number
  error?: string
}> {
  try {
    console.log(`[Payment] Verifying transaction: ${txHash}`)

    return {
      verified: false,
      confirmations: 0,
      error: 'Solana verification integration pending',
    }
  } catch (error) {
    return {
      verified: false,
      confirmations: 0,
      error: error instanceof Error ? error.message : 'Unknown verification error',
    }
  }
}

export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
}
