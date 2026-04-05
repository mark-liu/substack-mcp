import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubstackConfig } from '../types.js';
import { SubstackAuthError } from '../errors.js';
import type { SubstackHTTP } from './http.js';

const CONFIG_DIR = '.config/substack-mcp';
const AUTH_FILE = 'auth.json';
const KEY_FILE = '.key';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/** Persisted auth file structure. */
interface AuthFileData {
  email?: string;
  encryptedToken: string;
  iv: string;
  tag: string;
  publicationUrl: string;
  storedAt: string;
}

/**
 * Authentication module for Substack session tokens.
 *
 * Session tokens are extracted from browser cookies (connect.sid / substack.sid).
 * Persisted to ~/.config/substack-mcp/ with AES-256-GCM encryption.
 *
 * Token resolution priority:
 *   1. Encrypted file at ~/.config/substack-mcp/auth.json
 *   2. SUBSTACK_SESSION_TOKEN environment variable
 */
export class SubstackAuth {
  private readonly config: SubstackConfig;
  private readonly http: SubstackHTTP;
  private token: string;

  constructor(config: SubstackConfig, http: SubstackHTTP) {
    this.config = config;
    this.http = http;
    this.token = config.sessionToken;
  }

  /**
   * Validate the current session token by making a lightweight API call.
   * Returns true if the token is valid, false otherwise. Never throws.
   */
  async validate(): Promise<boolean> {
    try {
      const url = `${this.config.publicationUrl.replace(/\/+$/, '')}/api/v1/drafts?limit=1`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Cookie': `connect.sid=${this.token}; substack.sid=${this.token}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[substack-auth] Token validation failed: ${message}`);
      return false;
    }
  }

  /**
   * Encrypt and persist a session token to ~/.config/substack-mcp/auth.json.
   * Creates the config directory and encryption key if they don't exist.
   */
  async storeToken(token: string, publicationUrl: string, email?: string): Promise<void> {
    const configPath = this.getConfigPath();
    await mkdir(configPath, { recursive: true });

    const key = await this.getOrCreateKey(configPath);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const data: AuthFileData = {
      encryptedToken: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      publicationUrl: publicationUrl.replace(/\/+$/, ''),
      storedAt: new Date().toISOString(),
    };
    if (email) {
      data.email = email;
    }

    const authPath = join(configPath, AUTH_FILE);
    await writeFile(authPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await chmod(authPath, 0o600);

    this.token = token;
  }

  /**
   * Load and decrypt a previously stored session token.
   * Returns the plaintext token or null if no stored token exists or decryption fails.
   */
  async loadToken(): Promise<string | null> {
    const configPath = this.getConfigPath();
    const authPath = join(configPath, AUTH_FILE);
    const keyPath = join(configPath, KEY_FILE);

    try {
      await access(authPath);
      await access(keyPath);
    } catch {
      return null;
    }

    try {
      const [rawAuth, key] = await Promise.all([
        readFile(authPath, 'utf8'),
        readFile(keyPath),
      ]);

      const data: AuthFileData = JSON.parse(rawAuth);
      const iv = Buffer.from(data.iv, 'base64');
      const tag = Buffer.from(data.tag, 'base64');
      const encrypted = Buffer.from(data.encryptedToken, 'base64');

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      const token = decrypted.toString('utf8');
      this.token = token;
      return token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[substack-auth] Failed to load stored token: ${message}`);
      return null;
    }
  }

  /** Return the current session token from memory. */
  getSessionToken(): string {
    return this.token;
  }

  // ── private ──────────────────────────────────────────────────

  /** Resolve the config directory path (~/.config/substack-mcp). */
  private getConfigPath(): string {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    if (!home) {
      throw new SubstackAuthError('Cannot determine home directory (HOME / USERPROFILE not set)');
    }
    return join(home, CONFIG_DIR);
  }

  /**
   * Read the encryption key from disk, or generate a new one.
   * Key is 32 bytes (AES-256), stored with mode 0600.
   */
  private async getOrCreateKey(configPath: string): Promise<Buffer> {
    const keyPath = join(configPath, KEY_FILE);

    try {
      await access(keyPath);
      const existing = await readFile(keyPath);
      if (existing.length === KEY_LENGTH) {
        return existing;
      }
      // Wrong length — regenerate
      console.error('[substack-auth] Existing key has wrong length, regenerating');
    } catch {
      // File doesn't exist — will create below
    }

    const key = randomBytes(KEY_LENGTH);
    await writeFile(keyPath, key);
    await chmod(keyPath, 0o600);
    return key;
  }
}
