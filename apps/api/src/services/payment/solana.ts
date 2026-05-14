import type { PrismaClient } from '@a2e/database'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'
import crypto from 'crypto'

export interface PaymentResult {
  success: boolean
  txHash?: string
  isDevMode: boolean
  error?: string
}

export interface BatchPaymentResult {
  success: boolean
  txHash?: string
  isDevMode: boolean
  recipients: number
  error?: string
}

export interface SolanaConfig {
  rpcUrl: string
  payerPrivateKey: string
  usdcMint?: string
  devMode: boolean
}

// USDC has 6 decimals
const USDC_DECIMALS = 6

// Default USDC mint addresses
const USDC_MINTS = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
}

// Logged at most once per process so the env-vs-DB source of the payer
// key is visible in Render boot logs without spamming every request.
let _payerKeySourceLogged = false
function logPayerKeySource(source: 'env' | 'db' | 'missing'): void {
  if (_payerKeySourceLogged) return
  _payerKeySourceLogged = true
  if (source === 'env') {
    console.log('[solana] payer key loaded from SOLANA_PAYER_KEY env var')
  } else if (source === 'db') {
    console.warn(
      '[solana] WARNING: payer key loaded from SettlementConfig DB column. ' +
        'Set SOLANA_PAYER_KEY env var and drop the DB value before going live. ' +
        '(blocker M1-#7)'
    )
  } else {
    console.log('[solana] no payer key configured; dev-mode mocking will be used')
  }
}

export async function getSolanaConfig(prisma: PrismaClient): Promise<SolanaConfig> {
  const config = await prisma.settlementConfig.findUnique({
    where: { id: 'default' },
  })

  // Prefer env var; fall back to DB column for the migration window.
  // The DB column is being deprecated (blocker M1-#7) and will be removed
  // once #4 (production wallet provisioning) plants the key in env.
  const envKey = process.env.SOLANA_PAYER_KEY?.trim()
  const dbKey = config?.payerPrivateKey?.trim()
  const payerPrivateKey = envKey || dbKey || ''
  logPayerKeySource(envKey ? 'env' : dbKey ? 'db' : 'missing')

  const hasRealConfig = config?.solanaRpcUrl && payerPrivateKey
  const devMode = process.env.PAYMENT_MODE !== 'live' || !hasRealConfig

  return {
    rpcUrl: config?.solanaRpcUrl ?? 'https://api.devnet.solana.com',
    payerPrivateKey,
    usdcMint: config?.usdcMint ?? undefined,
    devMode,
  }
}

function generateDevTxHash(): string {
  // Generate a realistic-looking Solana transaction hash for dev mode
  const bytes = crypto.randomBytes(64)
  return bytes.toString('base64').replace(/[+/=]/g, '').substring(0, 88)
}

/**
 * Parses a Solana secret key supplied as a string. Accepts:
 *   1. JSON array — `[1,2,3,...64 bytes]` (Solana CLI export format)
 *   2. Base58     — `5urdR4z2yf...` (Phantom export, default in most wallets)
 *   3. Base64     — `AQID...` (legacy fallback)
 *
 * Result is the 64-byte Ed25519 expanded secret key, ready for
 * `Keypair.fromSecretKey()`.
 */
function parsePrivateKey(privateKeyString: string): Uint8Array {
  const trimmed = privateKeyString.trim()

  // 1. JSON array
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.length === 64) {
        return Uint8Array.from(parsed)
      }
    } catch {
      // fall through
    }
  }

  // 2. Base58 (canonical Solana wallet export). Solana secret keys are
  //    always 64 bytes; in base58 that's an 87–88 char string.
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
    try {
      const bytes = bs58.decode(trimmed)
      if (bytes.length === 64) return Uint8Array.from(bytes)
    } catch {
      // fall through
    }
  }

  // 3. Base64 fallback (older configs)
  try {
    const bytes = Uint8Array.from(Buffer.from(trimmed, 'base64'))
    if (bytes.length === 64) return bytes
  } catch {
    // fall through
  }

  throw new Error('Invalid private key format. Expected JSON array, base58, or base64 (64 bytes).')
}

function getUsdcMint(config: SolanaConfig): PublicKey {
  if (config.usdcMint) {
    return new PublicKey(config.usdcMint)
  }
  // Determine network from RPC URL
  const isMainnet = config.rpcUrl.includes('mainnet')
  return new PublicKey(isMainnet ? USDC_MINTS.mainnet : USDC_MINTS.devnet)
}

async function getOrCreateAssociatedTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const associatedToken = await getAssociatedTokenAddress(mint, owner)

  try {
    await getAccount(connection, associatedToken)
    return associatedToken
  } catch {
    // Account doesn't exist, create it
    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, associatedToken, owner, mint)
    )
    await sendAndConfirmTransaction(connection, transaction, [payer])
    return associatedToken
  }
}

export async function processPayment(
  config: SolanaConfig,
  recipientAddress: string,
  amountUsd: number,
  currency: 'SOL' | 'USDC' = 'USDC'
): Promise<PaymentResult> {
  console.log(
    `[Payment] Processing ${currency} payment of $${amountUsd} to ${recipientAddress} (devMode: ${config.devMode})`
  )

  // DEV MODE: Simulate successful payment
  if (config.devMode) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const mockTxHash = `DEV_${generateDevTxHash()}`
    console.log(`[Payment] DEV MODE: Simulated payment success, txHash: ${mockTxHash}`)

    return {
      success: true,
      txHash: mockTxHash,
      isDevMode: true,
    }
  }

  // LIVE MODE: Real Solana payment
  try {
    // Validate config
    if (!config.payerPrivateKey) {
      return {
        success: false,
        isDevMode: false,
        error: 'Solana payer private key not configured',
      }
    }

    if (!isValidSolanaAddress(recipientAddress)) {
      return {
        success: false,
        isDevMode: false,
        error: 'Invalid recipient Solana address',
      }
    }

    // Create connection
    const connection = new Connection(config.rpcUrl, 'confirmed')

    // Load payer keypair
    const payerSecretKey = parsePrivateKey(config.payerPrivateKey)
    const payer = Keypair.fromSecretKey(payerSecretKey)

    // Create recipient public key
    const recipient = new PublicKey(recipientAddress)

    let signature: string

    if (currency === 'SOL') {
      // SOL transfer
      // Note: This sends amountUsd worth of SOL at a fixed rate
      // In production, you'd fetch real-time SOL/USD price
      const solAmount = amountUsd / 100 // Simplified: assume $100/SOL for now
      const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL)

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports,
        })
      )

      signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
        commitment: 'confirmed',
      })
    } else {
      // USDC transfer
      const usdcMint = getUsdcMint(config)
      const amount = Math.floor(amountUsd * Math.pow(10, USDC_DECIMALS))

      // Get payer's token account
      const payerTokenAccount = await getAssociatedTokenAddress(usdcMint, payer.publicKey)

      // Get or create recipient's token account
      const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        recipient
      )

      // Create transfer instruction
      const transaction = new Transaction().add(
        createTransferInstruction(
          payerTokenAccount,
          recipientTokenAccount,
          payer.publicKey,
          amount,
          [],
          TOKEN_PROGRAM_ID
        )
      )

      signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
        commitment: 'confirmed',
      })
    }

    console.log(`[Payment] SUCCESS: Transaction confirmed, signature: ${signature}`)

    return {
      success: true,
      txHash: signature,
      isDevMode: false,
    }
  } catch (error) {
    console.error('[Payment] Error processing payment:', error)
    return {
      success: false,
      isDevMode: false,
      error: error instanceof Error ? error.message : 'Unknown payment error',
    }
  }
}

export async function processBatchPayment(
  config: SolanaConfig,
  recipients: Array<{ address: string; amount: number }>,
  currency: 'SOL' | 'USDC' = 'USDC'
): Promise<BatchPaymentResult> {
  console.log(
    `[Payment] Processing batch ${currency} payment to ${recipients.length} recipients (devMode: ${config.devMode})`
  )

  // DEV MODE: Simulate successful batch payment
  if (config.devMode) {
    await new Promise((resolve) => setTimeout(resolve, 500 + recipients.length * 100))
    const mockTxHash = `DEV_BATCH_${generateDevTxHash()}`
    console.log(`[Payment] DEV MODE: Simulated batch payment success, txHash: ${mockTxHash}`)

    return {
      success: true,
      txHash: mockTxHash,
      isDevMode: true,
      recipients: recipients.length,
    }
  }

  // LIVE MODE: Real Solana batch payment
  try {
    if (!config.payerPrivateKey) {
      return {
        success: false,
        isDevMode: false,
        recipients: 0,
        error: 'Solana payer private key not configured',
      }
    }

    // Validate all addresses first
    for (const recipient of recipients) {
      if (!isValidSolanaAddress(recipient.address)) {
        return {
          success: false,
          isDevMode: false,
          recipients: 0,
          error: `Invalid Solana address: ${recipient.address}`,
        }
      }
    }

    const connection = new Connection(config.rpcUrl, 'confirmed')
    const payerSecretKey = parsePrivateKey(config.payerPrivateKey)
    const payer = Keypair.fromSecretKey(payerSecretKey)

    const instructions: TransactionInstruction[] = []

    if (currency === 'SOL') {
      // Build SOL transfer instructions
      for (const recipient of recipients) {
        const solAmount = recipient.amount / 100 // Simplified rate
        const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL)

        instructions.push(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: new PublicKey(recipient.address),
            lamports,
          })
        )
      }
    } else {
      // Build USDC transfer instructions
      const usdcMint = getUsdcMint(config)
      const payerTokenAccount = await getAssociatedTokenAddress(usdcMint, payer.publicKey)

      for (const recipient of recipients) {
        const recipientPubkey = new PublicKey(recipient.address)
        const amount = Math.floor(recipient.amount * Math.pow(10, USDC_DECIMALS))

        // Check if recipient has token account, create if needed
        const recipientTokenAccount = await getAssociatedTokenAddress(usdcMint, recipientPubkey)

        try {
          await getAccount(connection, recipientTokenAccount)
        } catch {
          // Create associated token account
          instructions.push(
            createAssociatedTokenAccountInstruction(
              payer.publicKey,
              recipientTokenAccount,
              recipientPubkey,
              usdcMint
            )
          )
        }

        // Add transfer instruction
        instructions.push(
          createTransferInstruction(
            payerTokenAccount,
            recipientTokenAccount,
            payer.publicKey,
            amount,
            [],
            TOKEN_PROGRAM_ID
          )
        )
      }
    }

    // Create and send transaction with all instructions
    const transaction = new Transaction().add(...instructions)

    const signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: 'confirmed',
    })

    console.log(
      `[Payment] BATCH SUCCESS: ${recipients.length} payments confirmed, signature: ${signature}`
    )

    return {
      success: true,
      txHash: signature,
      isDevMode: false,
      recipients: recipients.length,
    }
  } catch (error) {
    console.error('[Payment] Error processing batch payment:', error)
    return {
      success: false,
      isDevMode: false,
      recipients: 0,
      error: error instanceof Error ? error.message : 'Unknown batch payment error',
    }
  }
}

export async function verifyTransaction(
  config: SolanaConfig,
  txHash: string
): Promise<{
  verified: boolean
  confirmations: number
  isDevMode: boolean
  slot?: number
  blockTime?: number
  error?: string
}> {
  console.log(`[Payment] Verifying transaction: ${txHash} (devMode: ${config.devMode})`)

  // DEV MODE: Auto-verify dev transactions
  if (config.devMode || txHash.startsWith('DEV_')) {
    return {
      verified: true,
      confirmations: 32, // Finalized
      isDevMode: true,
    }
  }

  // LIVE MODE: Real verification
  try {
    const connection = new Connection(config.rpcUrl, 'confirmed')

    // Get transaction status
    const status = await connection.getSignatureStatus(txHash, {
      searchTransactionHistory: true,
    })

    if (!status.value) {
      return {
        verified: false,
        confirmations: 0,
        isDevMode: false,
        error: 'Transaction not found',
      }
    }

    // Check for errors
    if (status.value.err) {
      return {
        verified: false,
        confirmations: 0,
        isDevMode: false,
        error: `Transaction failed: ${JSON.stringify(status.value.err)}`,
      }
    }

    // Get confirmation count
    const confirmations = status.value.confirmations ?? 0
    const isFinalized = status.value.confirmationStatus === 'finalized'

    // Get transaction details for block info
    const txDetails = await connection.getTransaction(txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })

    return {
      verified: true,
      confirmations: isFinalized ? 32 : confirmations,
      isDevMode: false,
      slot: txDetails?.slot,
      blockTime: txDetails?.blockTime ?? undefined,
    }
  } catch (error) {
    return {
      verified: false,
      confirmations: 0,
      isDevMode: false,
      error: error instanceof Error ? error.message : 'Unknown verification error',
    }
  }
}

export async function getPayerBalance(config: SolanaConfig): Promise<{
  sol: number
  usdc: number
  isDevMode: boolean
  error?: string
}> {
  if (config.devMode) {
    return {
      sol: 100,
      usdc: 10000,
      isDevMode: true,
    }
  }

  try {
    if (!config.payerPrivateKey) {
      return {
        sol: 0,
        usdc: 0,
        isDevMode: false,
        error: 'Payer not configured',
      }
    }

    const connection = new Connection(config.rpcUrl, 'confirmed')
    const payerSecretKey = parsePrivateKey(config.payerPrivateKey)
    const payer = Keypair.fromSecretKey(payerSecretKey)

    // Get SOL balance
    const solBalance = await connection.getBalance(payer.publicKey)
    const sol = solBalance / LAMPORTS_PER_SOL

    // Get USDC balance
    let usdc = 0
    try {
      const usdcMint = getUsdcMint(config)
      const tokenAccount = await getAssociatedTokenAddress(usdcMint, payer.publicKey)
      const accountInfo = await getAccount(connection, tokenAccount)
      usdc = Number(accountInfo.amount) / Math.pow(10, USDC_DECIMALS)
    } catch {
      // No USDC account or zero balance
    }

    return { sol, usdc, isDevMode: false }
  } catch (error) {
    return {
      sol: 0,
      usdc: 0,
      isDevMode: false,
      error: error instanceof Error ? error.message : 'Failed to get balance',
    }
  }
}

export function isValidSolanaAddress(address: string): boolean {
  // Solana addresses are base58 encoded, 32-44 characters
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return false
  }

  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

export function getPaymentModeInfo(): {
  mode: 'dev' | 'live'
  description: string
} {
  const mode = process.env.PAYMENT_MODE === 'live' ? 'live' : 'dev'
  return {
    mode,
    description:
      mode === 'dev'
        ? 'Development mode - payments are simulated, no real funds transferred'
        : 'Live mode - real Solana payments will be processed',
  }
}
