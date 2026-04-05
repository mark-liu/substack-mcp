# substack-mcp

[![npm version](https://img.shields.io/npm/v/@mark-liu/substack-mcp)](https://www.npmjs.com/package/@mark-liu/substack-mcp)
[![CI](https://github.com/mark-liu/substack-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mark-liu/substack-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP server for Substack publishing. Read and write to your Substack publication via the [Model Context Protocol](https://modelcontextprotocol.io/), using Substack's undocumented API.

## Safety model

The server has a two-tier design that controls which tools are available:

- **Read-only** (default) -- Six tools for listing posts, fetching drafts, checking subscriber counts, and previewing content. No state changes are possible.
- **Write mode** (opt-in via `SUBSTACK_ENABLE_WRITE=true`) -- Six additional tools for creating, updating, deleting, publishing, scheduling drafts, and uploading images.

Safety works through **omission, not permission**: write tools are never registered with the MCP server unless explicitly enabled. In read-only mode, the tools simply do not exist in the tool list -- there is nothing for the LLM to call.

Destructive operations (`delete_draft`, `publish_draft`) have an additional **confirmation gate**. The first call returns a preview of the affected draft. The caller must repeat the call with an explicit confirmation flag (`confirm_delete=true` or `confirm_publish=true`) to execute the action.

## Quick start

```bash
npx @mark-liu/substack-mcp
```

Requires two environment variables:

```bash
SUBSTACK_PUBLICATION_URL=https://yourpub.substack.com \
SUBSTACK_SESSION_TOKEN=your-session-token \
npx @mark-liu/substack-mcp
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUBSTACK_PUBLICATION_URL` | Yes | -- | Full URL of your publication (e.g. `https://example.substack.com`) |
| `SUBSTACK_SESSION_TOKEN` | Yes | -- | Session cookie value (see [Auth setup](#auth-setup)) |
| `SUBSTACK_ENABLE_WRITE` | No | `false` | Set to `true` to register write tools |
| `SUBSTACK_RATE_LIMIT` | No | `1` | Max API requests per second |
| `SUBSTACK_MAX_RETRIES` | No | `3` | Retry count for 429/5xx errors (exponential backoff) |

## Auth setup

Substack does not provide a public API or OAuth flow. Authentication uses a session cookie extracted from your browser.

### Extracting the session token

1. Log in to [substack.com](https://substack.com) in Chrome
2. Open DevTools (`F12` or `Cmd+Opt+I`)
3. Navigate to **Application** > **Cookies** > `https://substack.com`
4. Find `substack.sid` (or `connect.sid` on older sessions)
5. Copy the cookie **Value** -- this is your session token
6. Set it as `SUBSTACK_SESSION_TOKEN`

### Token storage

When the server starts, it can persist the session token to `~/.config/substack-mcp/auth.json`, encrypted with AES-256-GCM. A randomly generated encryption key is stored alongside at `~/.config/substack-mcp/.key`. Both files are created with mode `0600`.

On subsequent launches, the server checks for a stored token before falling back to the environment variable.

### Token lifetime

Session tokens typically last weeks but will expire if you log out of Substack in your browser, clear cookies, or if Substack rotates sessions server-side.

## Tool reference

### Read tools (always available)

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_published` | List published posts, newest first | `offset?` (int, default 0), `limit?` (int, 1-100, default 25) |
| `list_drafts` | List draft posts for the authenticated user | `offset?` (int, default 0), `limit?` (int, 1-100, default 25) |
| `get_draft` | Fetch a single draft by ID, including full body | `draft_id` (string, numeric ID) |
| `get_subscriber_count` | Current subscriber count for the publication | -- |
| `get_sections` | List all publication sections/categories | -- |
| `preview_draft` | Human-readable preview of a draft (title, subtitle, truncated body) | `draft_id` (string, numeric ID) |

### Write tools (requires `SUBSTACK_ENABLE_WRITE=true`)

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_draft` | Create a new draft from markdown content | `title` (string), `content` (string, markdown), `subtitle?` (string), `audience?` (`everyone` or `only_paid`) |
| `update_draft` | Update draft metadata | `draft_id` (string), `title?`, `subtitle?`, `slug?`, `section_id?` |
| `delete_draft` | Delete a draft (confirmation gate) | `draft_id` (string), `confirm_delete` (bool, default false) |
| `publish_draft` | Publish a draft immediately (confirmation gate) | `draft_id` (string), `send_email` (bool, default true), `confirm_publish` (bool, default false) |
| `schedule_draft` | Schedule a draft for future publication | `draft_id` (string), `post_date` (ISO 8601 datetime, must be future) |
| `upload_image` | Upload an image to Substack's CDN | `source` (string, local file path or URL) |

Image upload accepts `.jpg`, `.jpeg`, `.png`, `.gif`, and `.webp` files up to 10 MB. Local files are converted to base64 data URIs; URLs are passed to Substack for server-side fetch.

## Claude Code integration

```bash
claude mcp add substack -s user -- npx -y @mark-liu/substack-mcp
```

Or add directly to `~/.claude.json`:

```json
{
  "mcpServers": {
    "substack": {
      "command": "npx",
      "args": ["-y", "@mark-liu/substack-mcp"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourpub.substack.com",
        "SUBSTACK_SESSION_TOKEN": "your-session-token",
        "SUBSTACK_ENABLE_WRITE": "true"
      }
    }
  }
}
```

## Architecture

```
src/
  index.ts              -- Entrypoint: env var parsing, config, stdio transport
  server.ts             -- MCP tool registration (12 tools, conditional on config)
  types.ts              -- TypeScript interfaces (drafts, posts, ProseMirror nodes)
  errors.ts             -- Error hierarchy: SubstackError > AuthError, APIError, RateLimitError
  client/
    http.ts             -- Base HTTP client: cookie auth, token-bucket rate limiter, retry with backoff
    auth.ts             -- Session token encrypt/decrypt/validate (AES-256-GCM)
    reader.ts           -- Read-only API operations with lazy-fetch caching
    writer.ts           -- Write API operations with input validation
  converters/
    markdown.ts         -- Markdown -> ProseMirror via unified/remark AST walk
    prosemirror.ts      -- ProseMirror node type factories (Substack's editor schema)
```

Substack stores post bodies as [ProseMirror](https://prosemirror.net/) JSON documents. The `converters/` module translates between Markdown (what the LLM writes) and ProseMirror (what Substack's API expects). Supported node types: paragraphs, headings (h1-h6), code blocks, blockquotes, bullet lists, ordered lists, images (`captionedImage` wrapper), horizontal rules, and paywall dividers (`<!-- PAYWALL -->`). Inline marks: bold, italic, strikethrough, code, and links.

The HTTP client applies rate limiting via a token-bucket algorithm (default 1 req/s) and retries transient failures (429, 5xx) with exponential backoff up to a configurable retry count.

Reader methods for subscriber count, sections, tags, and users use lazy-fetch caching -- results are cached in memory after the first call and returned on subsequent requests without hitting the API. Pass `force_refresh: true` to bypass the cache.

## Development

```bash
git clone https://github.com/mark-liu/substack-mcp.git
cd substack-mcp
npm install
npm run dev          # Run with tsx (hot reload)
npm run build        # Compile TypeScript
npm run typecheck    # Type checking only
npm test             # Run vitest
```

Requires Node.js >= 20. CI runs `typecheck`, `lint`, and `test` against Node 20 and 22.

## Prior art

This project builds on research and patterns from five existing Substack integration projects:

- [python-substack](https://github.com/ma2za/python-substack) by ma2za -- API endpoint mapping and ProseMirror document format reference. The definitive source for understanding Substack's undocumented API surface.
- [substack-mcp-plus](https://github.com/ty13r/substack-mcp-plus) by ty13r -- Confirmation gate pattern for destructive operations and encrypted token storage at `~/.config/`.
- [substack-mcp](https://github.com/marcomoauro/substack-mcp) by marcomoauro -- ProseMirror node type registry. Informed the `converters/prosemirror.ts` factory design.
- [substack-mcp](https://github.com/conorbronsdon/substack-mcp) by conorbronsdon -- Safety-through-omission pattern: conditionally registering write tools rather than gating at call time.
- [substack_api](https://github.com/NHagar/substack_api) by NHagar -- Lazy-fetch caching pattern and publication ID resolution strategy.

## License

[MIT](LICENSE)
