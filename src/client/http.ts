import type { SubstackConfig } from '../types.js';
import { SubstackAPIError, SubstackRateLimitError, SubstackError } from '../errors.js';

const VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum allowed retries to prevent unbounded backoff. */
const MAX_RETRIES_CAP = 10;

/** Maximum backoff delay per retry attempt in milliseconds (30 seconds). */
const MAX_BACKOFF_MS = 30_000;

/**
 * Validate that a publication URL is safe (no SSRF).
 * Must be HTTPS and must not point to localhost, private IPs, or internal hostnames.
 */
function validatePublicationUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw new SubstackError(
      `SUBSTACK_PUBLICATION_URL must use HTTPS. Got: ${url}`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SubstackError(
      `SUBSTACK_PUBLICATION_URL is not a valid URL: ${url}`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block bare IP addresses (IPv4 and IPv6)
  const ipv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipv4.test(hostname) || hostname.startsWith('[')) {
    throw new SubstackError(
      `SUBSTACK_PUBLICATION_URL must not be an IP address: ${hostname}`,
    );
  }

  // Block localhost and loopback
  const blocked = ['localhost', 'localhost.localdomain', '127.0.0.1', '[::1]'];
  if (blocked.includes(hostname)) {
    throw new SubstackError(
      `SUBSTACK_PUBLICATION_URL must not point to localhost: ${hostname}`,
    );
  }

  // Block common internal hostnames
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.corp')) {
    throw new SubstackError(
      `SUBSTACK_PUBLICATION_URL must not point to an internal hostname: ${hostname}`,
    );
  }

  // Must be *.substack.com or a plausible custom domain (has a TLD with a dot)
  if (!hostname.endsWith('.substack.com') && !hostname.includes('.')) {
    throw new SubstackError(
      `SUBSTACK_PUBLICATION_URL must be a *.substack.com or valid custom domain: ${hostname}`,
    );
  }
}

/**
 * Base HTTP client for the Substack undocumented API.
 *
 * Handles authentication headers, rate limiting (token bucket),
 * and automatic retry with exponential backoff on 429/5xx.
 */
export class SubstackHTTP {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly rateLimitPerSecond: number;
  private lastRequestTime = 0;

  constructor(config: SubstackConfig) {
    validatePublicationUrl(config.publicationUrl);
    this.baseUrl = config.publicationUrl.replace(/\/+$/, '');
    this.token = config.sessionToken;

    // Cap maxRetries to prevent unbounded backoff (finding F-04 / item 9)
    if (!Number.isFinite(config.maxRetries) || config.maxRetries <= 0) {
      console.error(`[substack-http] Invalid maxRetries (${config.maxRetries}), defaulting to 3`);
      this.maxRetries = 3;
    } else if (config.maxRetries > MAX_RETRIES_CAP) {
      console.error(`[substack-http] maxRetries (${config.maxRetries}) exceeds cap of ${MAX_RETRIES_CAP}, clamping`);
      this.maxRetries = MAX_RETRIES_CAP;
    } else {
      this.maxRetries = config.maxRetries;
    }

    // Validate rateLimitPerSecond: must be a finite positive number (finding F-05 / item 8)
    if (!Number.isFinite(config.rateLimitPerSecond) || config.rateLimitPerSecond <= 0) {
      console.error(`[substack-http] Invalid rateLimitPerSecond (${config.rateLimitPerSecond}), defaulting to 1`);
      this.rateLimitPerSecond = 1;
    } else {
      this.rateLimitPerSecond = config.rateLimitPerSecond;
    }
  }

  /** Full API URL for a given path. */
  url(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}/api/v1${cleanPath}`;
  }

  /**
   * Issue an authenticated request to the Substack API.
   * Applies rate limiting and retries transparently.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.retryWithBackoff(async () => {
      await this.rateLimit();

      const headers: Record<string, string> = {
        'Cookie': `connect.sid=${this.token}; substack.sid=${this.token}`,
        'User-Agent': `substack-mcp/${VERSION}`,
        'Accept': 'application/json',
      };

      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      };

      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      const response = await fetch(this.url(path), init);
      return this.handleResponse<T>(response, path);
    }, this.maxRetries);
  }

  /** Convenience wrappers. */
  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /** Upload a file as multipart/form-data. */
  async upload<T>(path: string, formData: FormData): Promise<T> {
    return this.retryWithBackoff(async () => {
      await this.rateLimit();

      const headers: Record<string, string> = {
        'Cookie': `connect.sid=${this.token}; substack.sid=${this.token}`,
        'User-Agent': `substack-mcp/${VERSION}`,
        'Accept': 'application/json',
      };

      const response = await fetch(this.url(path), {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      return this.handleResponse<T>(response, path);
    }, this.maxRetries);
  }

  // ── private ──────────────────────────────────────────────────

  private async handleResponse<T>(response: Response, path: string): Promise<T> {
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new SubstackRateLimitError(
        path,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }

    if (!response.ok) {
      // Log full response for server-side debugging, but do NOT include
      // the response body in the error message returned to MCP clients
      // to avoid leaking sensitive data (finding F-03).
      const text = await response.text().catch(() => '(no body)');
      console.error(`[substack-http] API error on ${path}: ${response.status} ${response.statusText} — ${text}`);
      throw new SubstackAPIError(
        `Substack API error: ${response.status} ${response.statusText}`,
        response.status,
        path,
      );
    }

    // Some endpoints return 204 with no body
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    retriesLeft: number,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err instanceof SubstackRateLimitError ||
        (err instanceof SubstackAPIError && err.statusCode >= 500);

      if (!isRetryable || retriesLeft <= 0) {
        throw err;
      }

      const rawBackoff = 1000 * Math.pow(2, this.maxRetries - retriesLeft);
      const backoffMs = Math.min(rawBackoff, MAX_BACKOFF_MS);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return this.retryWithBackoff(fn, retriesLeft - 1);
    }
  }

  private async rateLimit(): Promise<void> {
    const minInterval = 1000 / this.rateLimitPerSecond;
    const elapsed = Date.now() - this.lastRequestTime;

    if (elapsed < minInterval) {
      await new Promise((resolve) => setTimeout(resolve, minInterval - elapsed));
    }

    this.lastRequestTime = Date.now();
  }
}
