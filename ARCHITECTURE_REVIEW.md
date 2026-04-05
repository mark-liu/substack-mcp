# Architecture Review: substack-mcp

Adversarial review. Every decision challenged. File:line references where applicable.

---

## 1. Is TypeScript the right choice?

**Verdict: Defensible, but the type safety is largely theatrical.**

The gain is real for the ProseMirror converter layer -- `ProseMirrorNode`, `ProseMirrorMark`, and the factory functions in `prosemirror.ts` do benefit from typed structures. You can't accidentally produce `{ type: 'paragrph' }` without the compiler noticing if you use the factories.

But the type safety collapses at the HTTP boundary. Every `http.get<T>()` call (`http.ts:68-70`) is a lie -- the generic parameter is a cast, not a validation. The return type at `http.ts:131` is `response.json() as Promise<T>`. There is zero runtime validation that the Substack API actually returned a `SubstackDraft` or `SubstackPost`. Against an undocumented API that can change shape without notice, this is exactly the situation where you need runtime validation (Zod schemas for API responses) and TypeScript's static types give you false confidence instead.

What we lost:
- The existing Python Substack libraries (python-substack, substack_api) have battle-tested endpoint discovery. We're re-deriving all of it.
- python-substack has 400+ stars and active maintenance. If an endpoint changes, they'll find it first.
- The Python MCP SDK is equally capable. We traded ecosystem maturity for compile-time checks that don't actually check the thing that matters (API response shapes).

What we gained:
- MCP SDK TypeScript is slightly more mature than the Python SDK (it's the reference implementation).
- The converter layer types are genuinely helpful.
- Node.js runtime is simpler to distribute (npx) than Python (pip, venv, version conflicts).

**Recommendation:** Keep TypeScript, but add Zod schemas for API response parsing. Replace every `http.get<T>(path)` with validated parsing. The types file (`types.ts`) already has the shapes -- convert them to Zod schemas and parse at the boundary.

---

## 2. Is the reader/writer split overengineered?

**Verdict: Yes, for the stated safety goal. No, for the actual useful property.**

The safety argument in the README -- "Write tools are never registered unless explicitly enabled" -- is about the MCP tool registration in `server.ts:142`, not about the reader/writer class split. The `if (writer)` guard at the server level is what provides the safety. The class split is orthogonal to it.

You could achieve identical safety with:

```typescript
const client = new SubstackClient(http);
if (config.enableWrite) {
  server.tool('create_draft', ..., async (args) => client.createDraft(...));
}
```

The split into `SubstackReader` and `SubstackWriter` classes gives you nothing that a single class wouldn't. The writer already imports from `../types.js` and uses the same `SubstackHTTP` instance. There's no interface segregation principle at play -- no consumer ever sees a `SubstackReader` reference and is prevented from calling write methods at the type level. The `server.ts` file uses both `reader` and `writer` directly, and the writer's `publishDraft` method at `server.ts:247` even calls `reader.getDraft(id)` through the closure for the confirmation preview.

What the split actually costs:
- `reader.ts` is 213 lines. `writer.ts` is 346 lines. A combined file would be ~500 lines -- manageable.
- The `getDraft` call in `delete_draft` and `publish_draft` confirmation paths (`server.ts:202`, `server.ts:234`) goes through the `reader` object even though the tool is gated behind the `writer` check. This works because `reader` is always created, but it's an odd coupling pattern.
- Two files to navigate instead of one.

**Recommendation:** Merge into a single `SubstackClient` class. The safety boundary is the tool registration gate in `server.ts`, not the class structure.

---

## 3. Is remark/unified overkill for markdown conversion?

**Verdict: It's the right call, but the dependency chain is heavier than it looks.**

The `markdown.ts` converter handles: headings, paragraphs, blockquotes, code blocks, ordered/unordered lists, horizontal rules, images (inline promotion to block), paywall markers from HTML comments, inline marks (bold, italic, strikethrough, inline code), links, hard breaks, and nested mark inheritance.

A regex parser could handle 80% of this. But the remaining 20% -- nested lists, inline marks within links within bold text, image detection inside single-child paragraphs (`markdown.ts:106-112`) -- is exactly where regex parsers break. The NHagar Python library uses regex and produces garbage for nested structures. This is the right trade-off.

Dependencies added for this:
- `unified` (core pipeline)
- `remark-parse` (markdown parser)
- `mdast-util-to-string` (listed in package.json but **never imported anywhere** -- dead dependency)

`mdast-util-to-string` at `package.json:25` is unused. The codebase has its own `extractPlainText` function at `markdown.ts:249-258` that does the same thing manually. Either use the library or remove it.

Bundle size impact: `unified` + `remark-parse` pull in micromark and about 15 transitive dependencies. For an MCP server that runs as a persistent process (not a Lambda, not a browser bundle), this is irrelevant. Startup time is the only concern, and it's negligible for a Node.js stdio server.

**Recommendation:** Drop `mdast-util-to-string` from dependencies -- it's dead weight. Keep unified/remark.

---

## 4. Error hierarchy depth

**Verdict: One level too deep. `SubstackRateLimitError` will never be caught distinctly.**

The hierarchy:
```
SubstackError
  SubstackAuthError
  SubstackAPIError
    SubstackRateLimitError
```

Where are these caught?

- `SubstackRateLimitError` is thrown at `http.ts:111` and caught at `http.ts:141` inside `retryWithBackoff`. After retries exhaust, it propagates up. The server catches it in the generic `catch (err)` blocks (`server.ts:54`, etc.) and calls `errorMessage(err)` which just extracts `.message`. The specific error type is **never discriminated by the caller**.

- `SubstackAPIError` is thrown at `http.ts:119`. Same story -- caught generically, message extracted.

- `SubstackAuthError` is thrown only in `auth.ts:160` (when HOME is not set). It's never caught anywhere -- it would crash the process.

- `SubstackError` is thrown by validation functions in `writer.ts`. Same generic catch path.

The `statusCode` and `endpoint` fields on `SubstackAPIError` (`errors.ts:17-18`) are never read by any caller. The `retryAfter` field on `SubstackRateLimitError` (`errors.ts:30`) is never used -- the retry logic uses exponential backoff regardless (`http.ts:149`), ignoring the server's `Retry-After` header value.

**This is premature abstraction.** You have 4 error classes where 2 would suffice (or even 1 with a `code` field).

**Recommendation:**
- Collapse to `SubstackError` with optional `statusCode` and `endpoint` fields.
- Actually use `retryAfter` in the backoff logic, or remove the field.
- If you keep the hierarchy, at least read `statusCode` somewhere.

---

## 5. Caching in the reader

**Verdict: The cache will almost never hit. It's dead complexity for the MCP use case.**

The reader caches: `subscriberCount`, `sections`, `tags`, `users` (`reader.ts:46-49`).

MCP servers process tool calls. Each call is independent. The LLM doesn't call `get_sections` twice in a row -- it calls it once, gets the result, and moves on. The cache would only hit if:

1. The LLM calls `get_sections`, then later in the same conversation calls it again. Possible but rare.
2. Two concurrent MCP sessions share the same server instance. Not how stdio MCP works -- each session is a separate process.

For `subscriber_count`, the cache is actively harmful. If you call `get_subscriber_count` at the start and end of a session to compare growth, the cache returns the stale first value. The `force_refresh` parameter exists to work around this, but the MCP tool definition at `server.ts:98-106` doesn't expose `force_refresh` to the LLM. It's an internal API that no one can reach.

The `getTags` and `getPublicationUsers` methods (`reader.ts:170-197`) aren't even exposed as MCP tools. They're internal reader methods with caching that nothing calls.

**Recommendation:** Remove all caching. For methods that aren't exposed as tools (`getTags`, `getPublicationUsers`), either expose them or remove them -- dead code is a liability.

---

## 6. Confirmation gates

**Verdict: Theatre. The LLM will call the tool twice with confirm=true in the same turn.**

The `delete_draft` tool (`server.ts:190-218`) and `publish_draft` tool (`server.ts:220-265`) use a two-call pattern: first call returns a preview, second call with `confirm_delete=true` or `confirm_publish=true` executes the action.

Here's why this doesn't work:

1. **The LLM controls the calls.** Claude can (and will, when instructed clearly) call `publish_draft` with `confirm_publish=true` in the very first call. The `default(false)` on the Zod schema (`server.ts:196`, `server.ts:233`) means it only defaults to false if omitted, but the tool description tells the LLM exactly how to bypass it.

2. **No state between calls.** There's no nonce, no session token, no "you must have seen the preview before confirming" check. The confirmation is purely advisory -- it depends on the LLM choosing to make two calls instead of one.

3. **The preview costs an API call.** The first call fetches the draft via `reader.getDraft(id)` to show a preview. If the LLM skips the preview (passes `confirm=true` directly), no preview is shown and the action executes immediately.

What would actually prevent accidental publishes:
- A server-side nonce generated on the preview call, required on the confirm call.
- A time-based lockout (must wait N seconds between preview and confirm).
- An external confirmation mechanism (webhook, Telegram prompt, etc.).

But honestly, for an MCP server, the real safety gate is `SUBSTACK_ENABLE_WRITE=true` being opt-in. If you've set that env var, you've accepted the risk. The confirmation dance adds complexity without adding safety.

**Recommendation:** Either make the gates real (nonce-based, stateful) or remove them and document that write mode means write mode. The current implementation gives a false sense of security.

---

## 7. File-based encrypted token storage

**Verdict: Security theatre that adds real operational complexity.**

`auth.ts` implements AES-256-GCM encryption for the session token, stored at `~/.config/substack-mcp/auth.json` with a key file at `~/.config/substack-mcp/.key`.

The threat model this addresses:
- Someone reads `auth.json` but not `.key` -- they can't decrypt the token.
- Someone reads `.key` but not `auth.json` -- they have a useless key.

The threat model this doesn't address:
- Both files are in the same directory with the same permissions (0o600). If an attacker can read one, they can read both. The encryption adds zero security margin.
- The encryption key is stored in plaintext on the same filesystem as the encrypted data. This is the "hiding the key under the doormat" pattern.
- The session token expires in weeks anyway. A 90-day-lifetime browser cookie doesn't justify AES-256-GCM.
- macOS Keychain, Linux secret-service, or `pass` would provide actual OS-level credential isolation. None are used.

What this costs:
- 190 lines of crypto code (`auth.ts`) that must be maintained.
- A `.key` file that if deleted, silently invalidates the stored token with no error message.
- Dependency on Node.js `crypto` module (not a problem in practice, but it's complexity).

The real issue: **`auth.ts` is never actually used by the server.** The `index.ts` entrypoint reads the token from `SUBSTACK_SESSION_TOKEN` env var (`index.ts:9`) and passes it to the config. The `SubstackAuth` class is instantiated nowhere in the startup path. It's a dead module. The entire auth.ts file is unused code.

**Recommendation:** Delete `auth.ts`. If token persistence is needed later, use the OS keychain (Keychain on macOS, libsecret on Linux). A plaintext file with 0o600 permissions would be equally secure to the current encryption scheme and 180 lines simpler.

---

## 8. Missing pieces

Things that will break on first real use:

### 8.1 No `update_draft` body editing
`update_draft` (`server.ts:168-188`) can change title, subtitle, slug, and section_id. It cannot update the **body** of a draft. The writer's `updateDraft` method (`writer.ts:121-169`) also omits body updates. This means: you can create a draft with markdown content, but you can never edit the content after creation. This is a critical gap.

### 8.2 No reverse conversion (ProseMirror to Markdown)
`get_draft` returns the raw ProseMirror JSON body (`reader.ts:95`). The LLM gets a JSON blob it must parse. There is no `prosemirrorToMarkdown` converter. When the LLM reads an existing draft to edit it, it receives the raw ProseMirror tree structure. Without a reverse converter, the round-trip workflow (read draft -> edit -> update) is broken.

### 8.3 No `get_published_post` tool
You can list published posts but not fetch a single post's full body. The `get_draft` tool exists for drafts but there's no equivalent for published posts. If you want to read an existing published post to create a follow-up, you can't.

### 8.4 Image upload is likely broken
The `uploadImage` method (`writer.ts:268-283`) sends either a URL string or a base64 data URI string as the POST body directly via `this.http.post('/image', imagePayload)`. This calls `http.ts:73` which sets `Content-Type: application/json` and does `JSON.stringify(body)`. Sending a raw string through `JSON.stringify` produces `"data:image/png;base64,..."` -- a JSON string, not a multipart form upload. The `upload` method exists in `http.ts:85-104` but is never called. The image upload almost certainly fails against the real API.

### 8.5 No graceful shutdown
The MCP server connects to stdio transport (`index.ts:44`) but never handles SIGINT/SIGTERM. If the parent process (Claude Desktop, Claude Code) terminates, the server process may zombie.

### 8.6 No tests
`tests/unit/.gitkeep` and `tests/fixtures/.gitkeep` are empty. The vitest config exists but there are zero test files. For a tool that can publish to a live audience, this is unacceptable. The confirmation gates, markdown conversion, ProseMirror factories, rate limiting, and retry logic are all untested.

### 8.7 No pagination auto-follow
`list_published` and `list_drafts` return one page. If you have 200 drafts, you need to manually paginate with offset. The LLM won't know it needs to -- nothing in the tool response indicates whether there are more results.

### 8.8 No content body update in `create_draft` response
When `create_draft` succeeds (`server.ts:157-160`), it returns `{ id, title, message }`. The LLM has no way to verify the body was correctly created without a separate `get_draft` call.

---

## 9. Dependency audit

### Runtime dependencies (package.json:21-26)

| Dependency | Verdict |
|---|---|
| `@modelcontextprotocol/sdk` | Required. This is an MCP server. |
| `zod` | Required. Used for tool parameter schemas. Already a transitive dep of the MCP SDK. |
| `unified` | Justified. See section 3. |
| `remark-parse` | Justified. Core parser for the markdown pipeline. |
| `mdast-util-to-string` | **UNUSED. Remove.** Not imported anywhere in the source tree. |

### Dev dependencies (package.json:28-33)

| Dependency | Verdict |
|---|---|
| `typescript` | Required. |
| `vitest` | Justified, but no tests exist yet. |
| `msw` | **Premature.** Mock Service Worker for HTTP mocking -- but there are no tests. Dead dev dependency. |
| `tsx` | Justified for `npm run dev`. |
| `@types/node` | Required. |

### Missing dependencies

- `node:crypto`, `node:fs/promises`, `node:path` -- all Node.js built-ins, fine.
- No Zod schemas for API response validation (see section 1).

### Transitive dependency bloat
The `node_modules` listing shows Express.js transitive dependencies (`body-parser`, `serve-static`, `router`, `cookie`, `send`, `finalhandler`, etc.). These come from `@modelcontextprotocol/sdk` which bundles an Express-based HTTP transport. Since this server uses stdio transport only, all of Express is dead weight in the dependency tree. Not actionable (it's the SDK's problem), but worth noting.

**Recommendation:** Remove `mdast-util-to-string` and `msw`. Add them back when there are actual tests/usages.

---

## 10. What I would block on

If this were a PR, I would block on the following before merge:

### Must fix (blocking)

1. **Image upload is broken** (`writer.ts:281-282`). It sends a string through `JSON.stringify` instead of using the `upload` method or multipart form. This will fail at runtime. Fix or remove the tool.

2. **Zero tests.** The markdown converter is the most complex and important module. It needs tests for: basic paragraphs, nested lists, bold-within-links, paywall markers, duplicate title stripping, image promotion from inline to block. Without these, any refactor will break things silently.

3. **`auth.ts` is dead code.** 190 lines that nothing calls. Remove it. If it's planned for future use, it belongs in a branch, not main.

4. **`mdast-util-to-string` is a dead dependency.** Remove from `package.json`.

5. **No body update capability.** You can create a draft but never edit its content. This makes the tool useless for the primary workflow (iterating on a draft). The `update_draft` tool and `writer.updateDraft` method both need a `content` parameter that runs through `markdownToProseMirror`.

6. **No ProseMirror-to-Markdown reverse converter.** Without this, `get_draft` returns opaque JSON. The LLM can't meaningfully read or edit existing drafts. This is the single biggest functional gap.

### Should fix (non-blocking but flagged)

7. **Confirmation gates are security theatre.** Either implement stateful nonces or remove the two-call dance and document the risk.

8. **API responses are not validated.** Add Zod schemas at the HTTP boundary. The `as T` cast at `http.ts:131` will silently produce garbage if the API changes shape.

9. **`retryAfter` field is ignored.** `http.ts:149` uses fixed exponential backoff while `SubstackRateLimitError.retryAfter` (`errors.ts:30`) goes unused. Either honour it or remove it.

10. **Reader cache is dead complexity.** Remove caching from `SubstackReader`. It will never meaningfully hit in the MCP stdio model.

11. **Unexposed methods.** `reader.getTags()` and `reader.getPublicationUsers()` exist but have no MCP tools. Either wire them up or delete them.

12. **`list_published`/`list_drafts` don't indicate pagination state.** Return `{ posts, has_more, total }` so the LLM knows whether to paginate.

---

## Summary

The core architecture -- stdio MCP server, markdown-to-ProseMirror conversion, HTTP client with rate limiting -- is sound. The choice of remark/unified is correct. The tool surface area is reasonable for a v0.1.

But there are two categories of problems:

**Dead code** (auth.ts, mdast-util-to-string, msw, reader caches, unexposed methods, unused error fields) -- approximately 300 lines that do nothing. This inflates the codebase by ~25% and creates maintenance burden.

**Missing code** (body updates, reverse converter, response validation, tests, pagination metadata) -- these are the things that will make the tool actually usable. Without body editing and ProseMirror-to-Markdown conversion, the create-read-edit loop is broken, which defeats the purpose of the tool.

Ship after fixing items 1-6 from the blocking list. The rest can land in follow-up PRs.
