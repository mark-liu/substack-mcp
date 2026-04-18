#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { SubstackAuth } from './client/auth.js';
import { SubstackHTTP } from './client/http.js';
import type { SubstackConfig } from './types.js';

/**
 * Parse an integer from an environment variable with validation.
 * Returns the default if the variable is unset, NaN, or non-positive.
 */
function parseEnvInt(envVar: string, defaultVal: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultVal;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`[substack-mcp] Invalid ${envVar}="${raw}", defaulting to ${defaultVal}`);
    return defaultVal;
  }
  return parsed;
}

function loadConfig(): SubstackConfig {
  const publicationUrl = process.env['SUBSTACK_PUBLICATION_URL'];
  const sessionToken = process.env['SUBSTACK_SESSION_TOKEN'];

  if (!publicationUrl) {
    console.error('Error: SUBSTACK_PUBLICATION_URL environment variable is required');
    console.error('Example: https://yourpub.substack.com');
    process.exit(1);
  }

  if (!sessionToken) {
    console.error('Error: SUBSTACK_SESSION_TOKEN environment variable is required');
    console.error('Extract from browser cookies: connect.sid or substack.sid');
    process.exit(1);
  }

  const enableWrite = process.env['SUBSTACK_ENABLE_WRITE'] === 'true';
  const rateLimitPerSecond = parseEnvInt('SUBSTACK_RATE_LIMIT', 1);
  const maxRetries = parseEnvInt('SUBSTACK_MAX_RETRIES', 3);

  return {
    publicationUrl,
    sessionToken,
    enableWrite,
    rateLimitPerSecond,
    maxRetries,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Soft-validate the session token on startup.
  const http = new SubstackHTTP(config);
  const auth = new SubstackAuth(config, http);
  const isValid = await auth.validate();
  if (!isValid) {
    console.error('[substack-mcp] WARNING: Session token validation failed — token may be expired');
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Deliberately no startup banner on stderr. Claude Code (and other MCP
  // clients) flag any stderr output as an `error` in their connection log,
  // which surfaces the server as "failed" in the UI even on a clean start.
  // The operator chose SUBSTACK_ENABLE_WRITE themselves; echoing it back on
  // stderr is noise, not signal. Keep stderr reserved for real problems
  // (missing env, bad config, auth failures, HTTP errors).
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
