import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { securityLogger } from '../utils/logger.js';

const log = securityLogger();

/**
 * Encryption algorithm
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
// AUTH_TAG_LENGTH used implicitly by cipher.getAuthTag()
const SALT_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Encrypted value format
 */
interface EncryptedValue {
  version: number;
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

/**
 * Credential Store Entry
 */
interface CredentialEntry {
  key: string;
  encryptedValue: EncryptedValue;
  createdAt: string;
  updatedAt: string;
}

/**
 * Credential Store
 */
interface CredentialStore {
  version: number;
  entries: CredentialEntry[];
}

/**
 * Credentials Manager - Secure storage for sensitive configuration
 */
export class CredentialsManager {
  private readonly storePath: string;
  private masterKey: Buffer | null = null;
  private store: CredentialStore | null = null;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  /**
   * Initialize with master password
   */
  async initialize(masterPassword: string): Promise<void> {
    // Derive master key from password
    const salt = this.loadOrCreateSalt();
    this.masterKey = await this.deriveKey(masterPassword, salt);

    // Load existing store or create new one
    await this.loadStore();

    log.info('Credentials manager initialized');
  }

  /**
   * Store a credential
   */
  async storeCredential(key: string, value: string): Promise<void> {
    if (!this.masterKey || !this.store) {
      throw new Error('Credentials manager not initialized');
    }

    const encrypted = this.encrypt(value);
    const now = new Date().toISOString();

    // Find existing entry
    const existingIndex = this.store.entries.findIndex(e => e.key === key);

    if (existingIndex !== -1) {
      this.store.entries[existingIndex] = {
        key,
        encryptedValue: encrypted,
        createdAt: this.store.entries[existingIndex]!.createdAt,
        updatedAt: now,
      };
    } else {
      this.store.entries.push({
        key,
        encryptedValue: encrypted,
        createdAt: now,
        updatedAt: now,
      });
    }

    await this.saveStore();
    log.debug({ key }, 'Stored credential');
  }

  /**
   * Retrieve a credential
   */
  retrieve(key: string): string | null {
    if (!this.masterKey || !this.store) {
      throw new Error('Credentials manager not initialized');
    }

    const entry = this.store.entries.find(e => e.key === key);
    if (!entry) {
      return null;
    }

    try {
      return this.decrypt(entry.encryptedValue);
    } catch (error) {
      log.error({ error, key }, 'Failed to decrypt credential');
      return null;
    }
  }

  /**
   * Delete a credential
   */
  async delete(key: string): Promise<boolean> {
    if (!this.masterKey || !this.store) {
      throw new Error('Credentials manager not initialized');
    }

    const index = this.store.entries.findIndex(e => e.key === key);
    if (index === -1) {
      return false;
    }

    this.store.entries.splice(index, 1);
    await this.saveStore();
    log.debug({ key }, 'Deleted credential');
    return true;
  }

  /**
   * List all credential keys
   */
  listKeys(): string[] {
    if (!this.store) {
      throw new Error('Credentials manager not initialized');
    }
    return this.store.entries.map(e => e.key);
  }

  /**
   * Check if a credential exists
   */
  has(key: string): boolean {
    if (!this.store) {
      throw new Error('Credentials manager not initialized');
    }
    return this.store.entries.some(e => e.key === key);
  }

  /**
   * Clear all credentials
   */
  async clear(): Promise<void> {
    if (!this.store) {
      throw new Error('Credentials manager not initialized');
    }

    this.store.entries = [];
    await this.saveStore();
    log.info('Cleared all credentials');
  }

  /**
   * Change master password
   */
  async changeMasterPassword(newPassword: string): Promise<void> {
    if (!this.store) {
      throw new Error('Credentials manager not initialized');
    }

    // Decrypt all values with old key
    const decrypted: Array<{ key: string; value: string }> = [];
    for (const entry of this.store.entries) {
      const value = this.decrypt(entry.encryptedValue);
      decrypted.push({ key: entry.key, value });
    }

    // Generate new salt and key
    const newSalt = crypto.randomBytes(SALT_LENGTH);
    this.masterKey = await this.deriveKey(newPassword, newSalt);

    // Save new salt
    const saltPath = `${this.storePath}.salt`;
    fs.writeFileSync(saltPath, newSalt, { mode: 0o600 });

    // Re-encrypt all values with new key
    const now = new Date().toISOString();
    this.store.entries = decrypted.map(({ key, value }) => ({
      key,
      encryptedValue: this.encrypt(value),
      createdAt: now,
      updatedAt: now,
    }));

    await this.saveStore();
    log.info('Master password changed');
  }

  /**
   * Derive encryption key from password
   */
  private deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, 'sha512', (err, key) => {
        if (err) {
          reject(err);
        } else {
          resolve(key);
        }
      });
    });
  }

  /**
   * Load or create salt
   */
  private loadOrCreateSalt(): Buffer {
    const saltPath = `${this.storePath}.salt`;

    if (fs.existsSync(saltPath)) {
      return fs.readFileSync(saltPath);
    }

    // Create new salt
    const salt = crypto.randomBytes(SALT_LENGTH);
    const dir = path.dirname(saltPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
    return salt;
  }

  /**
   * Encrypt a value
   */
  private encrypt(value: string): EncryptedValue {
    if (!this.masterKey) {
      throw new Error('Master key not set');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    let encrypted = cipher.update(value, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    return {
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted,
    };
  }

  /**
   * Decrypt a value
   */
  private decrypt(encrypted: EncryptedValue): string {
    if (!this.masterKey) {
      throw new Error('Master key not set');
    }

    const iv = Buffer.from(encrypted.iv, 'base64');
    const authTag = Buffer.from(encrypted.authTag, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Load credential store from disk
   */
  private async loadStore(): Promise<void> {
    if (!fs.existsSync(this.storePath)) {
      this.store = {
        version: 1,
        entries: [],
      };
      return;
    }

    try {
      const content = fs.readFileSync(this.storePath, 'utf8');
      this.store = JSON.parse(content) as CredentialStore;
      log.debug({ entryCount: this.store.entries.length }, 'Loaded credential store');
    } catch (error) {
      log.warn({ error }, 'Failed to load credential store, creating new one');
      this.store = {
        version: 1,
        entries: [],
      };
    }
  }

  /**
   * Save credential store to disk
   */
  private async saveStore(): Promise<void> {
    if (!this.store) {
      throw new Error('Store not initialized');
    }

    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Atomic write
    const tempPath = `${this.storePath}.tmp`;
    const content = JSON.stringify(this.store, null, 2);

    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.storePath);
  }

  /**
   * Destroy sensitive data in memory
   */
  destroy(): void {
    if (this.masterKey) {
      // Overwrite key in memory
      crypto.randomFillSync(this.masterKey);
      this.masterKey = null;
    }
    this.store = null;
  }
}

/**
 * Set secure file permissions
 */
export function setSecurePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
    log.debug({ path: filePath }, 'Set secure permissions (600)');
  } catch (error) {
    log.warn({ error, path: filePath }, 'Failed to set secure permissions');
  }
}

/**
 * Check if file has secure permissions
 */
export function hasSecurePermissions(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    const mode = stats.mode & 0o777;

    // Check that only owner has access (600 or 400)
    if (mode !== 0o600 && mode !== 0o400) {
      log.warn({ path: filePath, mode: mode.toString(8) }, 'File has insecure permissions');
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Mask sensitive values in logs
 */
export function maskSensitive(value: string, visibleChars: number = 4): string {
  if (value.length <= visibleChars * 2) {
    return '*'.repeat(value.length);
  }

  const prefix = value.slice(0, visibleChars);
  const suffix = value.slice(-visibleChars);
  const masked = '*'.repeat(Math.min(value.length - visibleChars * 2, 20));

  return `${prefix}${masked}${suffix}`;
}
