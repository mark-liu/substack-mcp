import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv } from 'node:crypto';

// Mock fs/promises before importing the module under test
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  access: vi.fn(),
}));

import { mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import type { SubstackConfig } from '../../src/types.js';

// We need to import SubstackAuth after mocks are set up
const { SubstackAuth } = await import('../../src/client/auth.js');

function makeConfig(overrides?: Partial<SubstackConfig>): SubstackConfig {
  return {
    publicationUrl: 'https://test.substack.com',
    sessionToken: 'test-session-token-abc',
    enableWrite: false,
    rateLimitPerSecond: 1,
    maxRetries: 3,
    ...overrides,
  };
}

function makeMockHttp() {
  return {} as any;
}

describe('SubstackAuth', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env['HOME'] = '/home/testuser';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getSessionToken', () => {
    it('returns the token from config', () => {
      const config = makeConfig({ sessionToken: 'my-token' });
      const auth = new SubstackAuth(config, makeMockHttp());
      expect(auth.getSessionToken()).toBe('my-token');
    });
  });

  describe('validate', () => {
    it('returns true when fetch responds with 200', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      const result = await auth.validate();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.substack.com/api/v1/drafts?limit=1');
      expect(init.method).toBe('GET');
      expect(init.headers['Cookie']).toContain('connect.sid=');
      expect(init.headers['Cookie']).toContain('substack.sid=');

      vi.unstubAllGlobals();
    });

    it('returns false when fetch responds with non-ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      expect(await auth.validate()).toBe(false);

      vi.unstubAllGlobals();
    });

    it('returns false on network error (soft fail)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      expect(await auth.validate()).toBe(false);

      consoleSpy.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe('loadToken', () => {
    it('returns null when auth file does not exist', async () => {
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      const result = await auth.loadToken();
      expect(result).toBeNull();
    });

    it('decrypts and returns a previously stored token', async () => {
      // Encrypt a token manually to simulate a stored file
      const key = randomBytes(32);
      const iv = randomBytes(16);
      const token = 'decrypted-session-token';
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(token, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      const authData = JSON.stringify({
        encryptedToken: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        publicationUrl: 'https://test.substack.com',
        storedAt: new Date().toISOString(),
      });

      vi.mocked(access).mockResolvedValue(undefined);
      vi.mocked(readFile).mockImplementation(((path: string, encoding?: string) => {
        if (path.endsWith('.key')) return Promise.resolve(key);
        return Promise.resolve(authData);
      }) as any);

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      const result = await auth.loadToken();
      expect(result).toBe(token);
      // Also updates internal state
      expect(auth.getSessionToken()).toBe(token);
    });

    it('returns null on decryption failure', async () => {
      vi.mocked(access).mockResolvedValue(undefined);
      vi.mocked(readFile).mockImplementation(((path: string) => {
        if (path.endsWith('.key')) return Promise.resolve(randomBytes(32));
        return Promise.resolve(JSON.stringify({
          encryptedToken: 'garbage',
          iv: 'garbage',
          tag: 'garbage',
          publicationUrl: 'https://test.substack.com',
          storedAt: new Date().toISOString(),
        }));
      }) as any);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      const result = await auth.loadToken();
      expect(result).toBeNull();

      consoleSpy.mockRestore();
    });
  });

  describe('storeToken', () => {
    it('creates config directory and writes encrypted auth file', async () => {
      // access throws ENOENT so getOrCreateKey generates a new key
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(mkdir).mockResolvedValue(undefined);
      vi.mocked(writeFile).mockResolvedValue(undefined);
      vi.mocked(chmod).mockResolvedValue(undefined);

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      await auth.storeToken('new-token', 'https://test.substack.com', 'user@example.com');

      // mkdir called for config directory
      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining('.config/substack-mcp'),
        { recursive: true },
      );

      // writeFile called twice: once for the key, once for the auth file
      expect(writeFile).toHaveBeenCalledTimes(2);

      // chmod called twice: once for the key, once for the auth file
      expect(chmod).toHaveBeenCalledTimes(2);
      expect(chmod).toHaveBeenCalledWith(
        expect.stringContaining('.key'),
        0o600,
      );
      expect(chmod).toHaveBeenCalledWith(
        expect.stringContaining('auth.json'),
        0o600,
      );

      // Verify the written auth data is valid JSON with expected fields
      const authWriteCall = vi.mocked(writeFile).mock.calls.find(
        (call) => String(call[0]).endsWith('auth.json'),
      );
      expect(authWriteCall).toBeDefined();
      const authData = JSON.parse(authWriteCall![1] as string);
      expect(authData).toHaveProperty('encryptedToken');
      expect(authData).toHaveProperty('iv');
      expect(authData).toHaveProperty('tag');
      expect(authData.publicationUrl).toBe('https://test.substack.com');
      expect(authData.email).toBe('user@example.com');
      expect(authData).toHaveProperty('storedAt');

      // Updates internal token
      expect(auth.getSessionToken()).toBe('new-token');
    });

    it('strips trailing slashes from publicationUrl', async () => {
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      await auth.storeToken('tok', 'https://test.substack.com///');

      const authWriteCall = vi.mocked(writeFile).mock.calls.find(
        (call) => String(call[0]).endsWith('auth.json'),
      );
      const authData = JSON.parse(authWriteCall![1] as string);
      expect(authData.publicationUrl).toBe('https://test.substack.com');
    });

    it('omits email when not provided', async () => {
      vi.mocked(access).mockRejectedValue(new Error('ENOENT'));

      const auth = new SubstackAuth(makeConfig(), makeMockHttp());
      await auth.storeToken('tok', 'https://test.substack.com');

      const authWriteCall = vi.mocked(writeFile).mock.calls.find(
        (call) => String(call[0]).endsWith('auth.json'),
      );
      const authData = JSON.parse(authWriteCall![1] as string);
      expect(authData.email).toBeUndefined();
    });
  });
});
