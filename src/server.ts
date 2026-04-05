import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SubstackConfig } from './types.js';
import { SubstackHTTP } from './client/http.js';
import { SubstackReader } from './client/reader.js';
import { SubstackWriter } from './client/writer.js';
import { markdownToProseMirror } from './converters/markdown.js';
import { SubstackAPIError } from './errors.js';

/** TTL for confirmation nonces in milliseconds (5 minutes). */
const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * Stateful nonce store for confirmation gates.
 * Each nonce maps to the draft ID it was generated for and expires after NONCE_TTL_MS.
 */
class NonceStore {
  private nonces = new Map<string, { draftId: number; expiresAt: number }>();

  /** Generate a nonce for a draft operation and store it with a TTL. */
  generate(draftId: number): string {
    this.cleanup();
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(nonce, { draftId, expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Validate and consume a nonce. Returns true if valid and matching draftId. */
  consume(nonce: string, draftId: number): boolean {
    this.cleanup();
    const entry = this.nonces.get(nonce);
    if (!entry) return false;
    if (entry.draftId !== draftId) return false;
    if (Date.now() > entry.expiresAt) {
      this.nonces.delete(nonce);
      return false;
    }
    this.nonces.delete(nonce);
    return true;
  }

  /** Remove expired nonces. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.nonces) {
      if (now > value.expiresAt) {
        this.nonces.delete(key);
      }
    }
  }
}

/**
 * Create and configure the Substack MCP server.
 *
 * Read tools are always registered. Write tools are only registered
 * when `config.enableWrite` is true, providing a safety boundary.
 *
 * Read tools (always available):
 * - list_published   — list all published posts
 * - list_drafts      — list all draft posts
 * - get_draft        — get a single draft by ID (full body)
 * - get_subscriber_count — current subscriber count
 * - get_sections     — list publication sections
 * - preview_draft    — render markdown to ProseMirror preview
 *
 * Write tools (only when enableWrite=true):
 * - create_draft     — create a new draft from markdown
 * - update_draft     — update an existing draft (metadata and/or body)
 * - delete_draft     — delete a draft (nonce-based confirmation gate)
 * - publish_draft    — publish a draft immediately (nonce-based confirmation gate)
 * - schedule_draft   — schedule a draft for future publication
 * - upload_image     — upload an image to Substack CDN
 */
export function createServer(config: SubstackConfig): McpServer {
  const server = new McpServer({
    name: 'substack-mcp',
    version: '0.1.0',
  });

  const http = new SubstackHTTP(config);
  const reader = new SubstackReader(http);
  const writer = config.enableWrite ? new SubstackWriter(http) : null;
  const nonceStore = new NonceStore();

  // ── Read tools (always available) ───────────────────────────

  server.tool(
    'list_published',
    'List published posts, newest first. Supports pagination.',
    {
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max posts to return (default 25)'),
    },
    async ({ offset, limit }) => {
      try {
        const posts = await reader.listPublished({ offset, limit });
        return { content: [{ type: 'text', text: JSON.stringify(posts, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );

  server.tool(
    'list_drafts',
    'List draft posts for the authenticated user. Supports pagination.',
    {
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max drafts to return (default 25)'),
    },
    async ({ offset, limit }) => {
      try {
        const drafts = await reader.listDrafts({ offset, limit });
        return { content: [{ type: 'text', text: JSON.stringify(drafts, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );

  server.tool(
    'get_draft',
    'Get a single draft by ID, including the full body content.',
    {
      draft_id: z.string().max(20).describe('Numeric ID of the draft'),
    },
    async ({ draft_id }) => {
      try {
        const id = parseIntStrict(draft_id, 'draft_id');
        const draft = await reader.getDraft(id);
        return { content: [{ type: 'text', text: JSON.stringify(draft, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );

  server.tool(
    'get_subscriber_count',
    'Get the current subscriber count for the publication.',
    {},
    async () => {
      try {
        const count = await reader.getSubscriberCount();
        return { content: [{ type: 'text', text: JSON.stringify({ subscriber_count: count }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );

  server.tool(
    'get_sections',
    'Get all sections (categories) on the publication.',
    {},
    async () => {
      try {
        const sections = await reader.getSections();
        return { content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );

  server.tool(
    'preview_draft',
    'Preview a draft\'s content as rendered text. Returns title, subtitle, and truncated body for confirmation flows.',
    {
      draft_id: z.string().max(20).describe('Numeric ID of the draft to preview'),
    },
    async ({ draft_id }) => {
      try {
        const id = parseIntStrict(draft_id, 'draft_id');
        const draft = await reader.getDraft(id);
        const preview = formatDraftPreview(draft.draft_title, draft.draft_subtitle, draft.draft_body);
        return { content: [{ type: 'text', text: preview }] };
      } catch (err) {
        return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
      }
    },
  );

  // ── Write tools (only when writer is available) ─────────────

  if (writer) {
    server.tool(
      'create_draft',
      'Create a new draft post from markdown content.',
      {
        title: z.string().min(1).max(500).describe('Draft title'),
        content: z.string().min(1).max(500_000).describe('Post body in markdown format'),
        subtitle: z.string().max(1000).optional().describe('Draft subtitle'),
        audience: z.enum(['everyone', 'only_paid']).optional().describe('Audience visibility (default: everyone)'),
      },
      async ({ title, content, subtitle, audience }) => {
        try {
          const body = markdownToProseMirror(content, title);
          const draft = await writer.createDraft(title, body, { subtitle, audience });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ id: draft.id, title: draft.draft_title, message: 'Draft created successfully' }, null, 2),
            }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      },
    );

    server.tool(
      'update_draft',
      'Update draft metadata and/or body content. Provide only the fields you want to change.',
      {
        draft_id: z.string().max(20).describe('Numeric ID of the draft to update'),
        title: z.string().min(1).max(500).optional().describe('New title'),
        subtitle: z.string().max(1000).optional().describe('New subtitle'),
        content: z.string().min(1).max(500_000).optional().describe('New body content in markdown format'),
        slug: z.string().min(1).max(200).optional().describe('New URL slug'),
        section_id: z.string().max(20).optional().describe('Section ID to assign (numeric)'),
      },
      async ({ draft_id, title, subtitle, content, slug, section_id }) => {
        try {
          const id = parseIntStrict(draft_id, 'draft_id');
          const sectionId = section_id !== undefined ? parseIntStrict(section_id, 'section_id') : undefined;
          const body = content !== undefined ? markdownToProseMirror(content, title) : undefined;
          const updated = await writer.updateDraft(id, { title, subtitle, slug, sectionId, body });
          return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      },
    );

    server.tool(
      'delete_draft',
      'Delete a draft. Requires nonce-based confirmation — first call returns a preview and a confirmation nonce, second call with confirm_delete=true and the nonce actually deletes.',
      {
        draft_id: z.string().max(20).describe('Numeric ID of the draft to delete'),
        confirm_delete: z.boolean().default(false).describe('Set to true to confirm deletion'),
        confirmation_nonce: z.string().max(64).optional().describe('Nonce from the preview step (required when confirm_delete=true)'),
      },
      async ({ draft_id, confirm_delete, confirmation_nonce }) => {
        try {
          const id = parseIntStrict(draft_id, 'draft_id');

          if (!confirm_delete) {
            const draft = await reader.getDraft(id);
            const preview = formatDraftPreview(draft.draft_title, draft.draft_subtitle, draft.draft_body);
            const nonce = nonceStore.generate(id);
            return {
              content: [{
                type: 'text',
                text: `Are you sure you want to DELETE this draft?\n\n${preview}\n\nCall again with confirm_delete=true and confirmation_nonce="${nonce}" to proceed.`,
              }],
            };
          }

          if (!confirmation_nonce || !nonceStore.consume(confirmation_nonce, id)) {
            return {
              content: [{
                type: 'text',
                text: 'Invalid or expired confirmation nonce. Please request a new preview first.',
              }],
              isError: true,
            };
          }

          await writer.deleteDraft(id);
          return { content: [{ type: 'text', text: `Draft ${draft_id} deleted successfully.` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      },
    );

    server.tool(
      'publish_draft',
      'Publish a draft immediately. Requires nonce-based confirmation — first call returns a preview and a confirmation nonce, second call with confirm_publish=true and the nonce publishes.',
      {
        draft_id: z.string().max(20).describe('Numeric ID of the draft to publish'),
        send_email: z.boolean().default(true).describe('Whether to email subscribers (default: true)'),
        confirm_publish: z.boolean().default(false).describe('Set to true to confirm publishing'),
        confirmation_nonce: z.string().max(64).optional().describe('Nonce from the preview step (required when confirm_publish=true)'),
      },
      async ({ draft_id, send_email, confirm_publish, confirmation_nonce }) => {
        try {
          const id = parseIntStrict(draft_id, 'draft_id');

          if (!confirm_publish) {
            const draft = await reader.getDraft(id);
            const emailNote = send_email
              ? 'This will publish AND email subscribers.'
              : 'This will publish WITHOUT emailing subscribers.';
            const preview = formatDraftPreview(draft.draft_title, draft.draft_subtitle, draft.draft_body);
            const nonce = nonceStore.generate(id);
            return {
              content: [{
                type: 'text',
                text: `Ready to PUBLISH?\n\n${preview}\n\n${emailNote}\n\nCall again with confirm_publish=true and confirmation_nonce="${nonce}" to proceed.`,
              }],
            };
          }

          if (!confirmation_nonce || !nonceStore.consume(confirmation_nonce, id)) {
            return {
              content: [{
                type: 'text',
                text: 'Invalid or expired confirmation nonce. Please request a new preview first.',
              }],
              isError: true,
            };
          }

          const post = await writer.publishDraft(id, {
            send: send_email,
            shareAutomatically: false,
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: post.id,
                title: post.title,
                canonical_url: post.canonical_url,
                message: 'Draft published successfully',
              }, null, 2),
            }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      },
    );

    server.tool(
      'schedule_draft',
      'Schedule a draft for future publication at a specific date and time.',
      {
        draft_id: z.string().max(20).describe('Numeric ID of the draft to schedule'),
        post_date: z.string().max(100).describe('ISO 8601 datetime string for when to publish (must be in the future)'),
      },
      async ({ draft_id, post_date }) => {
        try {
          const id = parseIntStrict(draft_id, 'draft_id');
          await writer.scheduleDraft(id, { postDate: post_date });
          return { content: [{ type: 'text', text: `Draft ${draft_id} scheduled for ${post_date}.` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      },
    );

    server.tool(
      'upload_image',
      'Upload an image to Substack CDN. Accepts a local file path or a URL.',
      {
        source: z.string().min(1).max(10_000).describe('Local file path or URL of the image to upload'),
      },
      async ({ source }) => {
        try {
          const cdnUrl = await writer.uploadImage(source);
          return { content: [{ type: 'text', text: JSON.stringify({ url: cdnUrl }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
        }
      },
    );
  }

  return server;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract a sanitized, human-readable error message from an unknown thrown value.
 * For API errors, returns a generic message without the raw response body
 * to prevent information disclosure (finding F-03).
 */
function errorMessage(err: unknown): string {
  if (err instanceof SubstackAPIError) {
    // Return only the status code and a generic message — full details
    // are logged server-side in http.ts handleResponse().
    return `Substack API error (HTTP ${err.statusCode}). Check server logs for details.`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Parse a string as a strict positive integer.
 * Only accepts decimal digit strings (no hex, no exponential notation).
 * Throws if the string is not a valid integer or is <= 0.
 */
function parseIntStrict(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label}: must be a positive integer (decimal digits only), got "${value}"`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Format a draft's title, subtitle, and body into a human-readable preview.
 * Truncates the body to keep the preview concise.
 */
function formatDraftPreview(title: string, subtitle: string, bodyJson: string): string {
  const lines: string[] = [];
  lines.push(`Title: ${title}`);
  if (subtitle) {
    lines.push(`Subtitle: ${subtitle}`);
  }

  const bodyText = extractBodyText(bodyJson);
  if (bodyText) {
    const truncated = bodyText.length > 500
      ? bodyText.slice(0, 500) + '...'
      : bodyText;
    lines.push(`\nBody preview:\n${truncated}`);
  }

  return lines.join('\n');
}

/**
 * Extract plain text from a ProseMirror JSON body string.
 * Walks the node tree and concatenates all text nodes.
 */
function extractBodyText(bodyJson: string): string {
  try {
    const doc = JSON.parse(bodyJson) as { content?: Array<Record<string, unknown>> };
    if (!doc.content) return '';
    return walkTextNodes(doc.content);
  } catch {
    return '';
  }
}

/** Recursively collect text from a ProseMirror node array. */
function walkTextNodes(nodes: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (typeof node['text'] === 'string') {
      parts.push(node['text']);
    }
    if (Array.isArray(node['content'])) {
      parts.push(walkTextNodes(node['content'] as Array<Record<string, unknown>>));
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
