/**
 * Akash mTLS certificate helper.
 *
 * Akash deployments require the deploying wallet to have a published mTLS
 * certificate on-chain — providers verify it when serving status/logs. The
 * cert is one-time per wallet; subsequent deployments reuse it.
 *
 * Queries go through Akash REST (stable, reliable). Transactions go through
 * cosmjs Stargate via chain-sdk's createStargateClient (uses the RPC
 * endpoint that works).
 */

import { CertificateManager, type CertificatePem, type ChainNodeSDK } from '@akashnetwork/chain-sdk'
import { queryWalletCertificatesREST } from './akash-rest'

export interface CertificateInfo {
  serial: string
  state: string
}

const cm = new CertificateManager()

/** Generate a self-signed PEM cert for the wallet. Free, off-chain. */
export async function generateCertificate(address: string): Promise<CertificatePem> {
  return cm.generatePEM(address)
}

/**
 * Query the chain (via REST) for valid certs published by `owner`. Free,
 * read-only. Returns an array of cert metadata (typically 0 or 1 entries).
 */
export async function queryWalletCertificates(
  _sdk: ChainNodeSDK,
  owner: string,
  options: { restUrl?: string } = {}
): Promise<CertificateInfo[]> {
  const certs = await queryWalletCertificatesREST(owner, options.restUrl)
  return certs.map((c) => ({ serial: c.serial, state: c.state }))
}

/**
 * Publish a fresh PEM certificate to the Akash chain. Costs ~0.05 AKT in
 * gas. Throws if the broadcast fails or the chain returns a non-zero code.
 */
export async function publishCertificate(
  sdk: ChainNodeSDK,
  owner: string,
  pem: CertificatePem
): Promise<{ txHash: string }> {
  const certBytes = pemBodyToBytes(pem.cert)
  const pubKeyBytes = pemBodyToBytes(pem.publicKey)

  await sdk.akash.cert.v1.createCertificate({
    owner,
    cert: certBytes,
    pubkey: pubKeyBytes,
  })

  // chain-sdk wraps signing/broadcast; if it didn't throw, the tx succeeded.
  // Downstream callers can re-query via queryWalletCertificates() to confirm.
  return { txHash: '(broadcast via chain-sdk — verify via queryWalletCertificates)' }
}

/**
 * Ensure the wallet has a valid published cert. Queries first via REST,
 * publishes only if missing. Idempotent across restarts (chain is the
 * source of truth).
 */
export async function ensureCertificate(
  sdk: ChainNodeSDK,
  owner: string,
  options: { restUrl?: string } = {}
): Promise<{
  alreadyExisted: boolean
  pem?: CertificatePem
  serial?: string
  txHash?: string
}> {
  const existing = await queryWalletCertificatesREST(owner, options.restUrl)
  if (existing.length > 0) {
    return { alreadyExisted: true, serial: existing[0]!.serial }
  }

  const pem = await generateCertificate(owner)
  const { txHash } = await publishCertificate(sdk, owner, pem)
  return { alreadyExisted: false, pem, txHash }
}

/** Strip PEM armour and base64-decode. Returns DER bytes. */
function pemBodyToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return Uint8Array.from(Buffer.from(body, 'base64'))
}
