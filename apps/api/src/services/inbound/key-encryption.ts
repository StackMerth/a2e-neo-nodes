/**
 * T5a — AES-256-GCM at-rest encryption for ephemeral SSH private keys.
 *
 * Private keys never travel to the buyer's browser in plaintext from
 * persistent storage: they're encrypted with a server-side key
 * (SSH_KEY_ENCRYPTION_KEY env, 32-byte hex) before INSERT and
 * decrypted on the rental detail page request.
 *
 * Format on disk (BalanceTransaction-style compact string):
 *   <hex iv (24 chars)>:<hex auth tag (32 chars)>:<hex ciphertext>
 *
 * AES-256-GCM gives authenticated encryption: any tamper to the
 * ciphertext or auth tag throws on decrypt, so a corrupted ExternalRental
 * row can never silently surface a wrong key.
 *
 * Key rotation: regenerate SSH_KEY_ENCRYPTION_KEY, set the new value
 * as SSH_KEY_ENCRYPTION_KEY_NEXT, run a one-shot script that
 * re-encrypts every row with the new key, then promote NEXT to
 * current. Out of scope for T5a — single key, no rotation needed
 * during the closed-beta window.
 *
 * Why GCM and not just symmetric encryption: without auth tag, a
 * bit-flip in the ciphertext silently yields a wrong key that the
 * buyer would copy into ssh -i and get cryptic "Permission denied"
 * errors. GCM forces the decrypt path to fail loudly instead.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard nonce size
const KEY_BYTES = 32

function loadKey(): Buffer {
  const raw = process.env.SSH_KEY_ENCRYPTION_KEY?.trim()
  if (!raw) {
    throw new Error(
      'SSH_KEY_ENCRYPTION_KEY env var is required. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
        'then add it to Render API service Environment.',
    )
  }
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `SSH_KEY_ENCRYPTION_KEY must be ${KEY_BYTES * 2} hex chars (${KEY_BYTES} bytes); got ${buf.length} bytes after decoding.`,
    )
  }
  return buf
}

export function isKeyEncryptionConfigured(): boolean {
  try {
    loadKey()
    return true
  } catch {
    return false
  }
}

/**
 * Encrypt a private key PEM string for at-rest storage. Output is
 * the compact "iv:tag:ciphertext" form parseable by decryptPrivateKey.
 */
export function encryptPrivateKey(plaintext: string): string {
  const key = loadKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/**
 * Decrypt a stored ciphertext back to the original PEM. Throws on
 * format errors, missing env var, wrong key, or any tamper (the GCM
 * auth tag catches all of these).
 */
export function decryptPrivateKey(stored: string): string {
  const key = loadKey()
  const parts = stored.split(':')
  if (parts.length !== 3) {
    throw new Error(`Stored key has wrong format: expected iv:tag:ciphertext, got ${parts.length} segments`)
  }
  const [ivHex, tagHex, encHex] = parts as [string, string, string]
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const enc = Buffer.from(encHex, 'hex')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return dec.toString('utf8')
}
