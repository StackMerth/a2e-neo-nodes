/**
 * Tests for the Akash signer factory.
 *
 * These verify deterministic address derivation against the real mnemonic
 * the client provided (a known funded wallet). RPC connection is NOT
 * exercised here — that costs nothing but makes tests order-dependent on
 * network state. createAkashSigner() is covered by integration tests where
 * the RPC is mocked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveAkashAddress } from '../adapters/akash-signer'

// The wallet we already verified funded on-chain via Polkachu RPC.
const PROD_MNEMONIC =
  'net minimum penalty salute burden train relax laptop butter help offer expose orient unaware basic across bonus market float appear exile scorpion foam police'
const PROD_ADDRESS = 'akash1ss9njzy5rwake7ud7ag6cakku4393vhv9ksm89'

describe('deriveAkashAddress', () => {
  const ORIG = process.env.AKASH_MNEMONIC

  beforeEach(() => {
    delete process.env.AKASH_MNEMONIC
  })

  afterEach(() => {
    if (ORIG !== undefined) process.env.AKASH_MNEMONIC = ORIG
    else delete process.env.AKASH_MNEMONIC
  })

  it('derives the expected address from the production mnemonic', async () => {
    const addr = await deriveAkashAddress(PROD_MNEMONIC)
    expect(addr).toBe(PROD_ADDRESS)
  })

  it('reads the mnemonic from AKASH_MNEMONIC env when no arg is supplied', async () => {
    process.env.AKASH_MNEMONIC = PROD_MNEMONIC
    const addr = await deriveAkashAddress()
    expect(addr).toBe(PROD_ADDRESS)
  })

  it('throws a clear error when no mnemonic is available', async () => {
    await expect(deriveAkashAddress()).rejects.toThrow(/AKASH_MNEMONIC/)
  })

  it('throws on a malformed mnemonic', async () => {
    await expect(deriveAkashAddress('not a real mnemonic phrase here')).rejects.toThrow()
  })
})
