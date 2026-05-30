/**
 * T5a — ephemeral SSH keypair generation per Lambda rental.
 *
 * For every Lambda-provisioned rental we mint a fresh ed25519 keypair,
 * upload the public key to Lambda (so it's installed in the new
 * instance's authorized_keys at boot), and store the encrypted
 * private key on the ExternalRental row for the buyer to download.
 *
 * Ed25519 instead of RSA: faster generation, smaller keys, modern
 * OpenSSH default. Every reasonable SSH client supports it.
 *
 * Format conversions:
 *   - Public key -> OpenSSH single-line format ("ssh-ed25519 AAAA...
 *     <comment>"). This is what Lambda's /ssh-keys endpoint expects
 *     and what gets dropped verbatim into the new instance's
 *     authorized_keys at boot.
 *   - Private key -> PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----\n...").
 *     Modern openssh clients (8.0+) accept PKCS#8 PEM for ed25519 via
 *     `ssh -i <file>`. Saves us writing the OpenSSH-format binary
 *     encoder by hand; if we ever see a client that requires the
 *     OpenSSH wrapper, we can add a converter then.
 *
 * Key name uniqueness: Lambda enforces unique name across the
 * account. We use `rental-${shortId}-${ts}` so collisions are
 * practically impossible across concurrent provisions.
 */

import { generateKeyPairSync, type KeyObject } from 'crypto'

export interface EphemeralKeypair {
  /**
   * Name we register with Lambda (passed to addSshKey, then to
   * launchInstance.ssh_key_names). Stored on the ExternalRental row
   * for cleanup.
   */
  keyName: string
  /** OpenSSH single-line format. Passed to addSshKey as public_key. */
  publicKeyOpenssh: string
  /** PKCS#8 PEM. Encrypted at rest before persisting to ExternalRental. */
  privateKeyPem: string
}

const OPENSSH_PREFIX = 'ssh-ed25519'

export function generateRentalKeypair(rentalId: string): EphemeralKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  const publicKeyOpenssh = ed25519PublicKeyToOpenssh(publicKey, rentalId)
  const privateKeyPem = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }).toString()

  // Short id + ms timestamp keeps the name under Lambda's 64-char
  // limit while staying unique across concurrent provisions.
  const keyName = `tokenos-${rentalId.slice(0, 12)}-${Date.now()}`

  return {
    keyName,
    publicKeyOpenssh,
    privateKeyPem,
  }
}

/**
 * Convert a Node ed25519 KeyObject to the single-line OpenSSH
 * authorized_keys format:
 *   ssh-ed25519 <base64(wire format)> <comment>
 *
 * The wire format is:
 *   uint32 length || "ssh-ed25519"  (4 + 11 bytes)
 *   uint32 length || <32-byte pubkey>  (4 + 32 bytes)
 *
 * Total 51 bytes -> base64 ~68 chars.
 */
function ed25519PublicKeyToOpenssh(publicKey: KeyObject, comment: string): string {
  // jwk export gives the 32-byte ed25519 public key as base64url in 'x'.
  // Decoding base64url and stripping any padding gives the raw 32 bytes.
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) {
    throw new Error('ed25519 public key export missing jwk.x')
  }
  const rawPubKey = Buffer.from(jwk.x, 'base64url')
  if (rawPubKey.length !== 32) {
    throw new Error(`expected 32 byte ed25519 pubkey, got ${rawPubKey.length}`)
  }

  const wire = Buffer.concat([
    writeString(OPENSSH_PREFIX),
    writeString(rawPubKey),
  ])

  return `${OPENSSH_PREFIX} ${wire.toString('base64')} ${comment}`
}

/**
 * Write a length-prefixed string in OpenSSH wire format:
 * 4-byte big-endian length || payload bytes.
 */
function writeString(value: string | Buffer): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  return Buffer.concat([length, payload])
}
