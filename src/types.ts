/** Core configuration for the Substack MCP server. */
export interface SubstackConfig {
  /** Full URL of the Substack publication (e.g. https://example.substack.com) */
  publicationUrl: string;
  /** Browser session token extracted from connect.sid / substack.sid cookie */
  sessionToken: string;
  /** Enable write operations (create, update, delete, publish). Default: false */
  enableWrite: boolean;
  /** Max API requests per second. Default: 1 */
  rateLimitPerSecond: number;
  /** Max retry attempts on transient failures (429, 5xx). Default: 3 */
  maxRetries: number;
}

/** A draft post in the Substack editor. */
export interface SubstackDraft {
  id: number;
  title: string;
  subtitle: string;
  slug: string;
  draft_body: string;
  draft_title: string;
  draft_subtitle: string;
  audience: 'everyone' | 'only_paid' | 'founding' | 'only_free';
  post_date: string | null;
  type: 'newsletter' | 'podcast' | 'thread';
  section_id: number | null;
  word_count: number;
  cover_image: string | null;
  description: string;
  write_comment_permissions: 'everyone' | 'only_paid' | 'none';
  draft_created_at: string;
  draft_updated_at: string;
}

/** A published post. */
export interface SubstackPost {
  id: number;
  title: string;
  subtitle: string;
  slug: string;
  post_date: string;
  audience: 'everyone' | 'only_paid' | 'founding' | 'only_free';
  canonical_url: string;
  type: 'newsletter' | 'podcast' | 'thread';
  section_id: number | null;
  cover_image: string | null;
  description: string;
  word_count: number;
  reactions: Record<string, number>;
  comment_count: number;
  write_comment_permissions: 'everyone' | 'only_paid' | 'none';
}

/** A publication tag. */
export interface SubstackTag {
  id: number;
  name: string;
  slug: string;
}

/** A publication section (e.g. "Podcast", "Notes"). */
export interface SubstackSection {
  id: number;
  name: string;
  slug: string;
}

/** A user on the publication. */
export interface SubstackUser {
  id: number;
  name: string;
  photo_url: string | null;
}

/** ProseMirror document — Substack's internal rich text format. */
export interface ProseMirrorDoc {
  type: 'doc';
  content: ProseMirrorNode[];
}

/** A single node in a ProseMirror document tree. */
export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

/** An inline mark (bold, italic, link, etc.) on a ProseMirror text node. */
export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** Options for publishing a draft. */
export interface PublishOptions {
  /** Whether to send the post as an email to subscribers. */
  send: boolean;
  /** Whether to share to connected social accounts automatically. */
  shareAutomatically: boolean;
}

/** Options for scheduling a draft. */
export interface ScheduleOptions {
  /** ISO 8601 datetime string for when to publish. */
  postDate: string;
}
