import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SubstackConfig } from '../../src/types.js';
import { SubstackHTTP } from '../../src/client/http.js';
import {
  SubstackAPIError,
  SubstackRateLimitError,
} from '../../src/errors.js';

function makeConfig(overrides?: Partial<SubstackConfig>): SubstackConfig {
  return {
    publicationUrl: 'https://test.substack.com',
    sessionToken: 'my-session-token',
    enableWrite: true,
    rateLimitPerSecond: 1000, // high limit to avoid delays in tests
    maxRetries: 1, // minimum valid value (0 gets defaulted to 3)
    ...overrides,
  };
}

function mockFetchOk(body: unknown = {}, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  });
}

function mockFetchError(status: number, statusText = 'Error', body = 'error body', headers?: Headers): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
    headers: headers ?? new Headers(),
  });
}

describe('SubstackHTTP', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('url', () => {
    it('constructs full API URL from path', () => {
      const http = new SubstackHTTP(makeConfig());
      expect(http.url('/drafts')).toBe('https://test.substack.com/api/v1/drafts');
    });

    it('handles path without leading slash', () => {
      const http = new SubstackHTTP(makeConfig());
      expect(http.url('drafts')).toBe('https://test.substack.com/api/v1/drafts');
    });

    it('strips trailing slashes from base URL', () => {
      const http = new SubstackHTTP(makeConfig({ publicationUrl: 'https://test.substack.com/' }));
      expect(http.url('/drafts')).toBe('https://test.substack.com/api/v1/drafts');
    });
  });

  describe('GET requests', () => {
    it('sends GET with correct headers', async () => {
      const fetchMock = mockFetchOk({ id: 1 });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      const result = await http.get<{ id: number }>('/drafts/1');

      expect(result).toEqual({ id: 1 });
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://test.substack.com/api/v1/drafts/1');
      expect(init.method).toBe('GET');
      expect(init.headers['Cookie']).toBe('connect.sid=my-session-token; substack.sid=my-session-token');
      expect(init.headers['User-Agent']).toMatch(/^substack-mcp\//);
      expect(init.headers['Accept']).toBe('application/json');
      expect(init.body).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  describe('POST requests', () => {
    it('sends POST with JSON body and Content-Type', async () => {
      const fetchMock = mockFetchOk({ id: 42 });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      const result = await http.post<{ id: number }>('/drafts', { title: 'Test' });

      expect(result).toEqual({ id: 42 });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ title: 'Test' }));

      vi.unstubAllGlobals();
    });
  });

  describe('PUT requests', () => {
    it('sends PUT with JSON body', async () => {
      const fetchMock = mockFetchOk({ id: 1 });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      await http.put('/drafts/1', { title: 'Updated' });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ title: 'Updated' }));

      vi.unstubAllGlobals();
    });
  });

  describe('DELETE requests', () => {
    it('sends DELETE with no body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: () => Promise.resolve(undefined),
        text: () => Promise.resolve(''),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      const result = await http.delete('/drafts/1');

      expect(result).toBeUndefined();
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('DELETE');
      expect(init.body).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  describe('error handling', () => {
    it('throws SubstackRateLimitError on 429', async () => {
      const headers = new Headers({ 'retry-after': '30' });
      const fetchMock = mockFetchError(429, 'Too Many Requests', 'rate limited', headers);
      vi.stubGlobal('fetch', fetchMock);

      // maxRetries: 1 means one retry attempt, so we need to advance through the backoff
      const http = new SubstackHTTP(makeConfig({ maxRetries: 1 }));

      const promise = http.get('/drafts').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2000); // advance past backoff

      const err = await promise;
      expect(err).toBeInstanceOf(SubstackRateLimitError);
      const rateErr = err as SubstackRateLimitError;
      expect(rateErr.statusCode).toBe(429);
      expect(rateErr.retryAfter).toBe(30);

      vi.unstubAllGlobals();
    });

    it('throws SubstackAPIError on 404', async () => {
      const fetchMock = mockFetchError(404, 'Not Found', 'not found');
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());

      const err = await http.get('/drafts/999').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubstackAPIError);
      const apiErr = err as SubstackAPIError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.endpoint).toBe('/drafts/999');

      vi.unstubAllGlobals();
    });

    it('throws SubstackAPIError on 401', async () => {
      const fetchMock = mockFetchError(401, 'Unauthorized', 'bad token');
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      await expect(http.get('/drafts')).rejects.toThrow(SubstackAPIError);

      vi.unstubAllGlobals();
    });

    it('throws SubstackAPIError on 400', async () => {
      const fetchMock = mockFetchError(400, 'Bad Request', 'invalid params');
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      await expect(http.get('/drafts')).rejects.toThrow(SubstackAPIError);

      vi.unstubAllGlobals();
    });
  });

  describe('retry with backoff', () => {
    it('retries on 429 and eventually succeeds', async () => {
      const headers429 = new Headers({ 'retry-after': '1' });
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: () => Promise.resolve('rate limited'),
            headers: headers429,
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ success: true }),
          headers: new Headers(),
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig({ maxRetries: 3 }));
      const promise = http.get<{ success: boolean }>('/drafts');

      // Advance timers through the backoff periods
      await vi.advanceTimersByTimeAsync(1000); // first backoff
      await vi.advanceTimersByTimeAsync(2000); // second backoff

      const result = await promise;
      expect(result).toEqual({ success: true });
      expect(callCount).toBe(3);

      vi.unstubAllGlobals();
    });

    it('retries on 500 server errors', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: () => Promise.resolve('server error'),
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ ok: true }),
          headers: new Headers(),
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig({ maxRetries: 2 }));
      const promise = http.get('/drafts');

      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(callCount).toBe(2);

      vi.unstubAllGlobals();
    });

    it('retries on 502 and 503', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: () => Promise.resolve('bad gateway'),
            headers: new Headers(),
          });
        }
        if (callCount === 2) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: () => Promise.resolve('unavailable'),
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ done: true }),
          headers: new Headers(),
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig({ maxRetries: 3 }));
      const promise = http.get('/drafts');

      await vi.advanceTimersByTimeAsync(1000); // first retry backoff
      await vi.advanceTimersByTimeAsync(2000); // second retry backoff

      const result = await promise;
      expect(result).toEqual({ done: true });
      expect(callCount).toBe(3);

      vi.unstubAllGlobals();
    });

    it('does not retry on 400', async () => {
      const fetchMock = mockFetchError(400, 'Bad Request', 'invalid');
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig({ maxRetries: 3 }));
      await expect(http.get('/drafts')).rejects.toThrow(SubstackAPIError);
      expect(fetchMock).toHaveBeenCalledOnce();

      vi.unstubAllGlobals();
    });

    it('does not retry on 401', async () => {
      const fetchMock = mockFetchError(401, 'Unauthorized', 'bad auth');
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig({ maxRetries: 3 }));
      await expect(http.get('/drafts')).rejects.toThrow(SubstackAPIError);
      expect(fetchMock).toHaveBeenCalledOnce();

      vi.unstubAllGlobals();
    });

    it('does not retry on 404', async () => {
      const fetchMock = mockFetchError(404, 'Not Found', 'missing');
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig({ maxRetries: 3 }));
      await expect(http.get('/drafts/999')).rejects.toThrow(SubstackAPIError);
      expect(fetchMock).toHaveBeenCalledOnce();

      vi.unstubAllGlobals();
    });

    it('throws after exhausting retries on 429', async () => {
      const headers429 = new Headers({ 'retry-after': '1' });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve('rate limited'),
        headers: headers429,
      });
      vi.stubGlobal('fetch', fetchMock);

      // Use maxRetries: 1 — will attempt once then retry once, then fail
      const http = new SubstackHTTP(makeConfig({ maxRetries: 1 }));

      const promise = http.get('/drafts').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2000); // advance past backoff

      const err = await promise;
      expect(err).toBeInstanceOf(SubstackRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry

      vi.unstubAllGlobals();
    });
  });

  describe('rate limiting', () => {
    it('spaces requests according to rateLimitPerSecond', async () => {
      const fetchMock = mockFetchOk({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      // 2 requests per second means 500ms between requests
      const http = new SubstackHTTP(makeConfig({ rateLimitPerSecond: 2 }));

      // First request should go through immediately
      const p1 = http.get('/drafts');
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      // Second request should be delayed
      const p2 = http.get('/drafts');
      await vi.advanceTimersByTimeAsync(500);
      await p2;

      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });
  });

  describe('204 No Content', () => {
    it('returns undefined on 204 response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', fetchMock);

      const http = new SubstackHTTP(makeConfig());
      const result = await http.delete('/drafts/1');
      expect(result).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });
});
