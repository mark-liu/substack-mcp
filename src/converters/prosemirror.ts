import type { ProseMirrorNode, ProseMirrorMark } from '../types.js';

/**
 * Factory functions for ProseMirror node types used by Substack.
 *
 * Substack stores post bodies as ProseMirror JSON. These factories
 * produce correctly-shaped nodes for the Substack editor's schema,
 * reverse-engineered from the Substack web client.
 */

// ── Mark constructors ──────────────────────────────────────────

/** Bold inline mark. */
export function boldMark(): ProseMirrorMark {
  return { type: 'bold' };
}

/** Italic inline mark. */
export function italicMark(): ProseMirrorMark {
  return { type: 'italic' };
}

/** Strikethrough inline mark. */
export function strikethroughMark(): ProseMirrorMark {
  return { type: 'strikethrough' };
}

/** Inline code mark. */
export function codeMark(): ProseMirrorMark {
  return { type: 'code' };
}

/** Hyperlink mark with Substack's required rel/target attrs. */
export function linkMark(href: string): ProseMirrorMark {
  return {
    type: 'link',
    attrs: { href, target: '_blank', rel: 'nofollow ugc noopener' },
  };
}

// ── Block node constructors ────────────────────────────────────

/** A paragraph containing inline content. */
export function paragraph(content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'paragraph', content };
}

/** A heading (h1-h6). */
export function heading(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  content: ProseMirrorNode[],
): ProseMirrorNode {
  return { type: 'heading', attrs: { level }, content };
}

/** A fenced code block with optional language. */
export function codeBlock(
  language: string | null,
  value: string,
): ProseMirrorNode {
  const node: ProseMirrorNode = {
    type: 'codeBlock',
    content: [{ type: 'text', text: value }],
  };
  if (language) {
    node.attrs = { params: language };
  }
  return node;
}

/** A blockquote wrapping block-level content. */
export function blockquote(content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'blockquote', content };
}

/** An unordered (bullet) list. Items are already list_item nodes. */
export function bulletList(items: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'bullet_list', content: items };
}

/** An ordered (numbered) list. Items are already list_item nodes. */
export function orderedList(items: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'ordered_list', attrs: { order: 1 }, content: items };
}

/** A single list item containing block-level content. */
export function listItem(content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'list_item', content };
}

/** A horizontal rule / divider. */
export function horizontalRule(): ProseMirrorNode {
  return { type: 'horizontal_rule' };
}

/**
 * An image wrapped in Substack's captionedImage container.
 *
 * Substack uses a two-level structure:
 * - captionedImage (outer wrapper)
 *   - image2 (actual image element with attrs)
 */
export function image(
  src: string,
  alt?: string,
  title?: string,
): ProseMirrorNode {
  const imageAttrs: Record<string, unknown> = {
    src,
    fullscreen: true,
    imageSize: 'normal',
  };
  if (alt) imageAttrs['alt'] = alt;
  if (title) imageAttrs['title'] = title;

  return {
    type: 'captionedImage',
    content: [{ type: 'image2', attrs: imageAttrs }],
  };
}

/** Substack's paywall divider node — content below is subscriber-only. */
export function paywall(): ProseMirrorNode {
  return { type: 'paywall' };
}

// ── Inline node constructor ────────────────────────────────────

/** A text node with optional inline marks (bold, italic, link, etc.). */
export function text(
  content: string,
  marks?: ProseMirrorMark[],
): ProseMirrorNode {
  const node: ProseMirrorNode = { type: 'text', text: content };
  if (marks && marks.length > 0) {
    node.marks = marks;
  }
  return node;
}
