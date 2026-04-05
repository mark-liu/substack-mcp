import { describe, it, expect } from 'vitest';
import {
  SubstackError,
  SubstackAuthError,
  SubstackAPIError,
  SubstackRateLimitError,
} from '../../src/errors.js';

describe('SubstackError', () => {
  it('sets name and message correctly', () => {
    const err = new SubstackError('something broke');
    expect(err.name).toBe('SubstackError');
    expect(err.message).toBe('something broke');
  });

  it('is an instance of Error', () => {
    const err = new SubstackError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SubstackError);
  });
});

describe('SubstackAuthError', () => {
  it('sets name and message correctly', () => {
    const err = new SubstackAuthError('bad token');
    expect(err.name).toBe('SubstackAuthError');
    expect(err.message).toBe('bad token');
  });

  it('is an instance of SubstackError and Error', () => {
    const err = new SubstackAuthError('bad token');
    expect(err).toBeInstanceOf(SubstackError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SubstackAuthError);
  });
});

describe('SubstackAPIError', () => {
  it('stores statusCode and endpoint', () => {
    const err = new SubstackAPIError('not found', 404, '/api/v1/drafts/999');
    expect(err.name).toBe('SubstackAPIError');
    expect(err.message).toBe('not found');
    expect(err.statusCode).toBe(404);
    expect(err.endpoint).toBe('/api/v1/drafts/999');
  });

  it('is an instance of SubstackError and Error', () => {
    const err = new SubstackAPIError('fail', 500, '/path');
    expect(err).toBeInstanceOf(SubstackError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SubstackAPIError);
  });

  it('is not an instance of SubstackAuthError', () => {
    const err = new SubstackAPIError('fail', 500, '/path');
    expect(err).not.toBeInstanceOf(SubstackAuthError);
  });
});

describe('SubstackRateLimitError', () => {
  it('sets statusCode to 429 and stores retryAfter', () => {
    const err = new SubstackRateLimitError('/drafts', 60);
    expect(err.name).toBe('SubstackRateLimitError');
    expect(err.statusCode).toBe(429);
    expect(err.endpoint).toBe('/drafts');
    expect(err.retryAfter).toBe(60);
    expect(err.message).toBe('Rate limited by Substack API');
  });

  it('retryAfter is undefined when not provided', () => {
    const err = new SubstackRateLimitError('/posts');
    expect(err.retryAfter).toBeUndefined();
  });

  it('is an instance of SubstackAPIError and SubstackError', () => {
    const err = new SubstackRateLimitError('/x');
    expect(err).toBeInstanceOf(SubstackAPIError);
    expect(err).toBeInstanceOf(SubstackError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SubstackRateLimitError);
  });
});
