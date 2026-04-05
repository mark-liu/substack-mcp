import { readFile, lstat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SubstackHTTP } from './http.js';
import type {
  SubstackDraft,
  SubstackPost,
  SubstackTag,
  ProseMirrorDoc,
  PublishOptions,
  ScheduleOptions,
} from '../types.js';
import { SubstackError } from '../errors.js';

/** Maximum draft body size in bytes (500 KB). */
const MAX_BODY_SIZE_BYTES = 500 * 1024;

/** Maximum image file size in bytes (10 MB). */
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

/** Allowed image file extensions for upload. */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** MIME types keyed by lowercase extension. */
const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Validate that a numeric ID is a positive integer.
 * Throws SubstackError if invalid.
 */
function validateId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SubstackError(
      `Invalid ${label}: must be a positive integer, got ${String(value)}`,
    );
  }
}

/**
 * Validate that a string is non-empty after trimming.
 * Throws SubstackError if invalid.
 */
function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SubstackError(`Invalid ${label}: must be a non-empty string`);
  }
}

/**
 * Serialize a ProseMirror body and validate it does not exceed the size limit.
 * Returns the serialized JSON string.
 */
function serializeBody(body: ProseMirrorDoc): string {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_SIZE_BYTES) {
    throw new SubstackError(
      `Draft body exceeds maximum size of ${MAX_BODY_SIZE_BYTES} bytes (500 KB)`,
    );
  }
  return serialized;
}

/**
 * Write operations against the Substack API.
 *
 * Only available when SUBSTACK_ENABLE_WRITE=true.
 * Destructive operations (delete, publish) require explicit confirmation
 * at the MCP tool layer.
 */
export class SubstackWriter {
  private readonly http: SubstackHTTP;

  constructor(http: SubstackHTTP) {
    this.http = http;
  }

  /**
   * Create a new draft post.
   *
   * @param title - Draft title (required, non-empty).
   * @param body - Post body as a ProseMirror document tree.
   * @param options - Optional fields: subtitle, audience, userId for byline.
   * @returns The created draft with its assigned ID.
   */
  async createDraft(
    title: string,
    body: ProseMirrorDoc,
    options?: {
      subtitle?: string;
      audience?: 'everyone' | 'only_paid';
      userId?: number;
    },
  ): Promise<SubstackDraft> {
    validateNonEmpty(title, 'title');

    const payload: Record<string, unknown> = {
      draft_title: title,
      draft_body: serializeBody(body),
      audience: options?.audience ?? 'everyone',
      type: 'newsletter',
    };

    if (options?.subtitle !== undefined) {
      payload['draft_subtitle'] = options.subtitle;
    }

    if (options?.userId !== undefined) {
      validateId(options.userId, 'userId');
      payload['draft_bylines'] = [{ id: options.userId }];
    }

    return this.http.post<SubstackDraft>('/drafts', payload);
  }

  /**
   * Update an existing draft.
   * Only provided fields are modified; others are left unchanged.
   *
   * @param draftId - Numeric ID of the draft to update.
   * @param updates - Partial fields to update.
   * @returns The updated draft.
   */
  async updateDraft(
    draftId: number,
    updates: {
      title?: string;
      subtitle?: string;
      slug?: string;
      searchEngineTitle?: string;
      searchEngineDescription?: string;
      sectionId?: number | null;
      body?: ProseMirrorDoc;
    },
  ): Promise<SubstackDraft> {
    validateId(draftId, 'draftId');

    const payload: Record<string, unknown> = {};

    if (updates.title !== undefined) {
      validateNonEmpty(updates.title, 'title');
      payload['draft_title'] = updates.title;
    }

    if (updates.subtitle !== undefined) {
      payload['draft_subtitle'] = updates.subtitle;
    }

    if (updates.slug !== undefined) {
      validateNonEmpty(updates.slug, 'slug');
      payload['slug'] = updates.slug;
    }

    if (updates.searchEngineTitle !== undefined) {
      payload['search_engine_title'] = updates.searchEngineTitle;
    }

    if (updates.searchEngineDescription !== undefined) {
      payload['search_engine_description'] = updates.searchEngineDescription;
    }

    if (updates.sectionId !== undefined) {
      if (updates.sectionId !== null) {
        validateId(updates.sectionId, 'sectionId');
      }
      payload['section_id'] = updates.sectionId;
    }

    if (updates.body !== undefined) {
      payload['draft_body'] = serializeBody(updates.body);
    }

    if (Object.keys(payload).length === 0) {
      throw new SubstackError('No update fields provided');
    }

    return this.http.put<SubstackDraft>(`/drafts/${draftId}`, payload);
  }

  /**
   * Delete a draft by ID. Irreversible.
   *
   * @param draftId - Numeric ID of the draft to delete.
   */
  async deleteDraft(draftId: number): Promise<void> {
    validateId(draftId, 'draftId');
    await this.http.delete<void>(`/drafts/${draftId}`);
  }

  /**
   * Publish a draft immediately.
   *
   * Calls prepublish validation first. If prepublish returns errors,
   * throws before attempting to publish.
   *
   * @param draftId - Numeric ID of the draft to publish.
   * @param options - Whether to send as email and/or share to socials.
   * @returns The published post.
   */
  async publishDraft(
    draftId: number,
    options: PublishOptions,
  ): Promise<SubstackPost> {
    validateId(draftId, 'draftId');

    // Run pre-publish validation
    const prepublish = await this.http.get<{ errors?: string[] }>(
      `/drafts/${draftId}/prepublish`,
    );

    if (prepublish.errors && prepublish.errors.length > 0) {
      throw new SubstackError(
        `Pre-publish validation failed: ${prepublish.errors.join(', ')}`,
      );
    }

    return this.http.post<SubstackPost>(`/drafts/${draftId}/publish`, {
      send: options.send,
      share_automatically: options.shareAutomatically,
    });
  }

  /**
   * Schedule a draft for future publication.
   *
   * @param draftId - Numeric ID of the draft to schedule.
   * @param options - Must include a future ISO 8601 postDate.
   */
  async scheduleDraft(
    draftId: number,
    options: ScheduleOptions,
  ): Promise<void> {
    validateId(draftId, 'draftId');
    validateNonEmpty(options.postDate, 'postDate');

    const scheduledDate = new Date(options.postDate);
    if (isNaN(scheduledDate.getTime())) {
      throw new SubstackError(
        `Invalid postDate: must be a valid ISO 8601 datetime string, got "${options.postDate}"`,
      );
    }

    if (scheduledDate.getTime() <= Date.now()) {
      throw new SubstackError(
        'Scheduled date must be in the future',
      );
    }

    await this.http.post<void>(`/drafts/${draftId}/schedule`, {
      post_date: scheduledDate.toISOString(),
    });
  }

  /**
   * Remove the scheduled date from a draft, returning it to draft state.
   *
   * @param draftId - Numeric ID of the draft to unschedule.
   */
  async unscheduleDraft(draftId: number): Promise<void> {
    validateId(draftId, 'draftId');
    await this.http.post<void>(`/drafts/${draftId}/schedule`, {
      post_date: null,
    });
  }

  /**
   * Upload an image to Substack's CDN.
   *
   * Accepts either a local file path or a remote URL.
   * - File path: reads file, validates extension and size, converts to base64 data URI.
   * - URL: passes directly to the API (Substack fetches it server-side).
   *
   * @param source - Local file path or remote URL.
   * @returns CDN URL of the uploaded image.
   */
  async uploadImage(source: string): Promise<string> {
    validateNonEmpty(source, 'image source');

    if (source.startsWith('http://') || source.startsWith('https://')) {
      // URL source — pass via multipart form
      const form = new FormData();
      form.append('image', source);
      const result = await this.http.upload<{ url: string }>('/image', form);
      return result.url;
    }

    // File path source — validate and convert to data URI, upload as form
    const dataUri = await this.readImageAsDataUri(source);
    const form = new FormData();
    form.append('image', dataUri);
    const result = await this.http.upload<{ url: string }>('/image', form);
    return result.url;
  }

  /**
   * Create a new tag on the publication.
   *
   * @param name - Tag name (non-empty).
   * @returns The created tag with its assigned ID and slug.
   */
  async createTag(name: string): Promise<SubstackTag> {
    validateNonEmpty(name, 'tag name');
    return this.http.post<SubstackTag>('/publication/post-tag', { name });
  }

  /**
   * Apply an existing tag to a post.
   *
   * @param postId - Numeric ID of the post.
   * @param tagId - Numeric ID of the tag.
   */
  async applyTag(postId: number, tagId: number): Promise<void> {
    validateId(postId, 'postId');
    validateId(tagId, 'tagId');
    await this.http.post<void>(`/post/${postId}/tag/${tagId}`);
  }

  // ── private ──────────────────────────────────────────────────

  /**
   * Read a local image file and return a base64 data URI string.
   * Validates extension, path safety (canonicalization, symlink check,
   * directory allowlist), and file size.
   */
  private async readImageAsDataUri(filePath: string): Promise<string> {
    // Reject URL-encoded sequences before any path resolution
    if (/%[0-9a-fA-F]{2}/.test(filePath)) {
      throw new SubstackError(
        'Image path must not contain URL-encoded sequences',
      );
    }

    // Canonicalize path to resolve any traversal components
    const resolved = resolve(filePath);

    // Verify resolved path is within allowed directories (cwd or home)
    const cwd = process.cwd();
    const home = homedir();
    if (!resolved.startsWith(cwd + '/') && !resolved.startsWith(home + '/') &&
        resolved !== cwd && resolved !== home) {
      throw new SubstackError(
        'Image path must be within the current working directory or home directory',
      );
    }

    const ext = extname(resolved).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      throw new SubstackError(
        `Unsupported image extension "${ext}". Allowed: ${[...ALLOWED_IMAGE_EXTENSIONS].join(', ')}`,
      );
    }

    // Use lstat (not stat) to detect symlinks — do not follow them
    const fileInfo = await lstat(resolved).catch(() => null);
    if (!fileInfo) {
      throw new SubstackError(`Image file not found: ${filePath}`);
    }

    if (fileInfo.isSymbolicLink()) {
      throw new SubstackError(
        'Image path must not be a symbolic link (security restriction)',
      );
    }

    if (!fileInfo.isFile()) {
      throw new SubstackError('Image path must point to a regular file');
    }

    if (fileInfo.size > MAX_IMAGE_SIZE_BYTES) {
      const sizeMB = (fileInfo.size / (1024 * 1024)).toFixed(1);
      throw new SubstackError(
        `Image file too large: ${sizeMB} MB (max 10 MB)`,
      );
    }

    const buffer = await readFile(resolved);
    const mime = EXTENSION_MIME[ext] ?? 'application/octet-stream';
    const base64 = buffer.toString('base64');
    return `data:${mime};base64,${base64}`;
  }
}
