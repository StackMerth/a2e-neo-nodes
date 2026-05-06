/**
 * Akash mTLS certificate helper.
 *
 * Akash deployments require the deploying wallet to have a published mTLS
 * certificate on-chain — providers verify it when serving status/logs. The
 * cert is one-time per wallet; subsequent deployments reuse it.
 *
 * Provided helpers:
 *   - generateCertificate(address)        — off-chain PEM (free)
 *   - queryWalletCertificates(sdk, owner) — typed query (free)
 *   - publishCertificate(...)             — on-chain submit (~0.05 AKT gas)
 *   - ensureCertificate(...)              — query first, publish only if needed
 */

import { CertificateManager, type CertificatePem, type ChainNodeSDK } from '@akashnetwork/chain-sdk'
import { Cert_State } from '@akashnetwork/chain-sdk/private-types/akash.v1'

export interface CertificateInfo {
  serial: string
  state: string
}

const cm = new CertificateManager()

/** Generate a self-signed PEM cert for the wallet. Free, off-chain. */
export async function generateCertificate(address: string): Promise<CertificatePem> {
  return cm.generatePEM(address)
}

/** Query the chain for valid certs published by `owner`. Free, read-only. */
export async function queryWalletCertificates(
  sdk: ChainNodeSDK,
  owner: string
): Promise<CertificateInfo[]> {
  const response = await sdk.akash.cert.v1.getCertificates({
    filter: { owner, serial: '', state: '' },
  })
  return (response.certificates ?? [])
    .filter((c) => c.certificate?.state === Cert_State.valid)
    .map((c) => ({
      serial: c.serial ?? '',
      state: 'valid',
    }))
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

  const response = await sdk.akash.cert.v1.createCertificate({
    owner,
    cert: certBytes,
    pubkey: pubKeyBytes,
  })

  // chain-sdk returns the typed Msg response; the surrounding tx is signed
  // and broadcast by the SDK. If it failed the call would throw, so reaching
  // here means success — but we don't get the raw txHash from this surface.
  // For our needs the response object's presence is enough; downstream code
  // queries getCertificates() to verify.
  void response
  return { txHash: '(via chain-sdk; verify with queryWalletCertificates)' }
}

/**
 * Ensure the wallet has a valid published cert. Queries first, publishes
 * only if missing. Idempotent across restarts because the chain is the
 * source of truth.
 */
export async function ensureCertificate(
  sdk: ChainNodeSDK,
  owner: string
): Promise<{
  alreadyExisted: boolean
  pem?: CertificatePem
  serial?: string
  txHash?: string
}> {
  const existing = await queryWalletCertificates(sdk, owner)
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
