export class SubstackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubstackError';
  }
}

export class SubstackAuthError extends SubstackError {
  constructor(message: string) {
    super(message);
    this.name = 'SubstackAuthError';
  }
}

export class SubstackAPIError extends SubstackError {
  public readonly statusCode: number;
  public readonly endpoint: string;

  constructor(message: string, statusCode: number, endpoint: string) {
    super(message);
    this.name = 'SubstackAPIError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

export class SubstackRateLimitError extends SubstackAPIError {
  public readonly retryAfter?: number;

  constructor(endpoint: string, retryAfter?: number) {
    super('Rate limited by Substack API', 429, endpoint);
    this.name = 'SubstackRateLimitError';
    this.retryAfter = retryAfter;
  }
}
