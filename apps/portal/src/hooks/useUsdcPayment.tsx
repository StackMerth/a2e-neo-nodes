'use client'

/**
 * Sign-and-send a USDC transfer from the user's connected wallet to
 * a platform-side recipient. Used by:
 *   - topup modal on /buyer/balance
 *   - buyer compute request (USDC payment path)
 *   - node-runner deploy payment
 *
 * Flow:
 *   1. Caller provides recipient address + USD amount.
 *   2. Hook builds a USDC SPL transfer (creates recipient ATA if
 *      missing), signs via wallet-adapter, sends, awaits confirmation.
 *   3. Returns the on-chain signature, which the caller posts to the
 *      backend (existing endpoints — no API changes needed).
 *
 * Errors surface as Error throws so the caller can show its own
 * toast / inline copy.
 */

import { useCallback, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import {
  PublicKey,
  Transaction,
  type Commitment,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

const USDC_DECIMALS = 6

// Mainnet USDC mint vs devnet USDC mint. The portal flips on
// NEXT_PUBLIC_SOLANA_NETWORK ('mainnet' or 'devnet'). Defaults to
// devnet to match the API's PAYMENT_MODE=dev default.
const USDC_MINTS: Record<'mainnet' | 'devnet', string> = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
}

function resolveNetwork(): 'mainnet' | 'devnet' {
  const n = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim()
  return n === 'mainnet' || n === 'mainnet-beta' ? 'mainnet' : 'devnet'
}

function resolveUsdcMint(): PublicKey {
  const override = process.env.NEXT_PUBLIC_SOLANA_USDC_MINT?.trim()
  if (override) return new PublicKey(override)
  return new PublicKey(USDC_MINTS[resolveNetwork()])
}

export interface UsdcPaymentArgs {
  recipient: string  // base58 Solana address
  amountUsd: number  // USD value, converted to USDC base units (6 decimals)
  commitment?: Commitment  // default 'confirmed'
}

export interface UsdcPaymentResult {
  signature: string
  network: 'mainnet' | 'devnet'
}

export function useUsdcPayment() {
  const { connection } = useConnection()
  const { publicKey, sendTransaction } = useWallet()
  const [submitting, setSubmitting] = useState(false)

  const pay = useCallback(
    async (args: UsdcPaymentArgs): Promise<UsdcPaymentResult> => {
      if (!publicKey || !sendTransaction) {
        throw new Error('No wallet connected. Click Connect Wallet first.')
      }
      if (args.amountUsd <= 0) {
        throw new Error('Amount must be greater than zero.')
      }

      const recipient = new PublicKey(args.recipient)
      const mint = resolveUsdcMint()
      const rawAmount = BigInt(Math.round(args.amountUsd * Math.pow(10, USDC_DECIMALS)))

      setSubmitting(true)
      try {
        const senderAta = await getAssociatedTokenAddress(mint, publicKey)
        const recipientAta = await getAssociatedTokenAddress(mint, recipient)

        const tx = new Transaction()

        // Create the recipient's USDC token account if it does not
        // exist yet — first-time topups to a fresh recipient need
        // this instruction or the transfer reverts.
        try {
          await getAccount(connection, recipientAta)
        } catch {
          tx.add(
            createAssociatedTokenAccountInstruction(
              publicKey,        // payer (we pay rent for the ATA we create)
              recipientAta,
              recipient,
              mint,
            ),
          )
        }

        tx.add(
          createTransferInstruction(
            senderAta,
            recipientAta,
            publicKey,
            rawAmount,
            [],
            TOKEN_PROGRAM_ID,
          ),
        )

        // wallet-adapter sets the blockhash + fee payer internally
        // when sendTransaction is invoked, then prompts the wallet
        // for a signature, then forwards to the connection.
        const signature = await sendTransaction(tx, connection)
        await connection.confirmTransaction(signature, args.commitment ?? 'confirmed')

        return { signature, network: resolveNetwork() }
      } finally {
        setSubmitting(false)
      }
    },
    [connection, publicKey, sendTransaction],
  )

  return {
    pay,
    submitting,
    walletConnected: !!publicKey,
    walletAddress: publicKey?.toBase58() ?? null,
    network: resolveNetwork(),
  }
}
