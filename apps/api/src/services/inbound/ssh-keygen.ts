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
 *   - Private key -> OpenSSH "openssh-key-v1" PEM
 *     ("-----BEGIN OPENSSH PRIVATE KEY-----\n..."). Originally PKCS#8
 *     PEM, but OpenSSH-for-Windows 9.5p2 (built against LibreSSL
 *     3.8.2) ships a PKCS#8 Ed25519 parser bug that rejects valid
 *     keys with "invalid format" — even after `Format-Hex` confirms
 *     the file is structurally correct. OpenSSH's own native format
 *     is always parsed by the openssh internal code path (never
 *     LibreSSL/OpenSSL), so it works on every platform regardless of
 *     the bundled libcrypto.
 *
 * Key name uniqueness: Lambda enforces unique name across the
 * account. We use `rental-${shortId}-${ts}` so collisions are
 * practically impossible across concurrent provisions.
 */

import { generateKeyPairSync, type KeyObject, randomBytes } from 'crypto'

export interface EphemeralKeypair {
  /**
   * Name we register with Lambda (passed to addSshKey, then to
   * launchInstance.ssh_key_names). Stored on the ExternalRental row
   * for cleanup.
   */
  keyName: string
  /** OpenSSH single-line format. Passed to addSshKey as public_key. */
  publicKeyOpenssh: string
  /**
   * OpenSSH "openssh-key-v1" PEM. Encrypted at rest before persisting
   * to ExternalRental. Field name kept as `privateKeyPem` for backward
   * compatibility with existing callers + DB rows that still hold
   * PKCS#8 PEM strings — the column is just a PEM string, the format
   * is whichever generateRentalKeypair was emitting at write time.
   */
  privateKeyPem: string
}

const OPENSSH_PREFIX = 'ssh-ed25519'

export function generateRentalKeypair(rentalId: string): EphemeralKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  const publicKeyOpenssh = ed25519PublicKeyToOpenssh(publicKey, rentalId)
  const privateKeyPem = ed25519PrivateKeyToOpensshPem(publicKey, privateKey, rentalId)

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

/**
 * Encode an Ed25519 keypair into OpenSSH's native "openssh-key-v1" PEM.
 * Spec: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 *
 * Format:
 *   "openssh-key-v1\0"                     // magic
 *   string ciphername                      // "none"
 *   string kdfname                         // "none"
 *   string kdfoptions                      // ""
 *   uint32 num_keys                        // 1
 *   string pubkey_blob                     // ssh-ed25519 wire encoding
 *   string encrypted_section               // for unencrypted, just the
 *                                          // raw private section + padding
 *
 * The private section (unencrypted) is:
 *   uint32 checkint                        // random
 *   uint32 checkint                        // same as above (acts as
 *                                          // integrity check after decrypt)
 *   string keyname                         // "ssh-ed25519"
 *   string pubkey                          // 32-byte ed25519 pubkey
 *   string privkey                         // 64 bytes: 32-byte seed
 *                                          // concatenated with 32-byte pubkey
 *   string comment
 *   bytes pad                              // 1,2,3... to make the section
 *                                          // a multiple of the cipher block
 *                                          // size (8 for "none")
 *
 * Then the entire outer blob is base64-encoded, wrapped to 70 chars,
 * and wrapped in BEGIN/END markers. OpenSSH parses this with its own
 * code path (NOT LibreSSL/OpenSSL), so it works on every client
 * version regardless of which libcrypto is bundled.
 */
function ed25519PrivateKeyToOpensshPem(
  publicKey: KeyObject,
  privateKey: KeyObject,
  comment: string,
): string {
  // Extract the raw 32-byte seed from the private key. JWK 'd' is the
  // base64url-encoded seed; 'x' is the base64url-encoded pubkey.
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string }
  if (!privJwk.d || !privJwk.x) {
    throw new Error('ed25519 private key export missing jwk.d or jwk.x')
  }
  const seed = Buffer.from(privJwk.d, 'base64url')
  const pub = Buffer.from(privJwk.x, 'base64url')
  if (seed.length !== 32 || pub.length !== 32) {
    throw new Error(`expected 32+32 byte seed+pub, got ${seed.length}+${pub.length}`)
  }
  // Sanity-check the public key matches the one we'd derive from the
  // public KeyObject — protects against a future Node refactor changing
  // jwk export semantics.
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string }
  if (pubJwk.x && Buffer.from(pubJwk.x, 'base64url').compare(pub) !== 0) {
    throw new Error('ed25519 jwk.x mismatch between public + private exports')
  }

  // Public key wire encoding: ssh-ed25519 || 32-byte pubkey.
  const pubkeyBlob = Buffer.concat([
    writeString(OPENSSH_PREFIX),
    writeString(pub),
  ])

  // Random checkint. Two copies act as a simple integrity check that
  // catches wrong-password decrypts (n/a here since we're unencrypted,
  // but the format requires the field).
  const checkint = randomBytes(4)
  const privateSection = Buffer.concat([
    checkint,
    checkint,
    writeString(OPENSSH_PREFIX),
    writeString(pub),
    // OpenSSH stores the private key as the 32-byte seed concatenated
    // with the 32-byte public key (64 bytes total). This is the same
    // layout libsodium's crypto_sign_keypair uses internally.
    writeString(Buffer.concat([seed, pub])),
    writeString(comment),
  ])
  // Pad to a multiple of 8 (cipher block size for "none"). Padding
  // bytes are 1, 2, 3, ... so the parser can verify by checking the
  // last byte equals the padding length.
  const blockSize = 8
  const padLen = (blockSize - (privateSection.length % blockSize)) % blockSize
  const padding = Buffer.alloc(padLen)
  for (let i = 0; i < padLen; i++) padding[i] = i + 1
  const paddedPrivate = Buffer.concat([privateSection, padding])

  const outer = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    writeString('none'),     // cipher
    writeString('none'),     // kdf
    writeString(''),         // kdf options
    Buffer.from([0, 0, 0, 1]), // num_keys = 1
    writeString(pubkeyBlob),
    writeString(paddedPrivate),
  ])

  // Base64 and wrap at 70 chars per OpenSSH convention.
  const b64 = outer.toString('base64')
  const wrapped = b64.match(/.{1,70}/g)?.join('\n') ?? b64
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`
}
