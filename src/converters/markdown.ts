import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import type { ProseMirrorDoc, ProseMirrorNode, ProseMirrorMark } from '../types.js';
import {
  paragraph,
  heading,
  codeBlock,
  blockquote,
  bulletList,
  orderedList,
  listItem,
  horizontalRule,
  image,
  paywall,
  text,
  boldMark,
  italicMark,
  strikethroughMark,
  codeMark,
  linkMark,
} from './prosemirror.js';

/** HTML comment that triggers a paywall node insertion. */
const PAYWALL_MARKER = /^<!--\s*PAYWALL\s*-->$/i;

/**
 * Convert a Markdown string to a Substack-compatible ProseMirror document.
 *
 * Uses unified/remark to parse Markdown into an MDAST, then walks the AST
 * to produce ProseMirror nodes matching Substack's editor schema.
 *
 * @param markdown - Raw Markdown source.
 * @param title - If provided and the first heading matches, skip it
 *                to avoid duplicate titles in Substack's editor.
 * @returns A ProseMirrorDoc ready for the Substack draft API.
 */
export function markdownToProseMirror(
  markdown: string,
  title?: string,
): ProseMirrorDoc {
  const tree = unified().use(remarkParse).parse(markdown);
  const content = convertRoot(tree, title);
  return { type: 'doc', content };
}

// ── Root conversion ────────────────────────────────────────────

/**
 * Walk the root node's children, converting each to ProseMirror block nodes.
 * Handles paywall markers and duplicate-title detection.
 */
function convertRoot(root: Root, title?: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  let skipFirstHeading = false;

  if (title && root.children.length > 0) {
    const first = root.children[0];
    if (first.type === 'heading') {
      const headingText = extractPlainText(first.children);
      if (headingText.trim() === title.trim()) {
        skipFirstHeading = true;
      }
    }
  }

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];

    // Skip duplicate title heading
    if (i === 0 && skipFirstHeading && child.type === 'heading') {
      continue;
    }

    pushConverted(nodes, convertBlockNode(child));
  }

  return nodes;
}

// ── Block node conversion ──────────────────────────────────────

/**
 * Convert a single mdast block node to one or more ProseMirror nodes.
 * Returns null for unsupported node types.
 */
function convertBlockNode(
  node: RootContent,
): ProseMirrorNode | ProseMirrorNode[] | null {
  switch (node.type) {
    case 'heading':
      return heading(
        node.depth as 1 | 2 | 3 | 4 | 5 | 6,
        convertInlineNodes(node.children),
      );

    case 'paragraph':
      // Check if paragraph contains only an image — promote to block image
      if (
        node.children.length === 1 &&
        node.children[0].type === 'image'
      ) {
        const img = node.children[0];
        return image(img.url, img.alt ?? undefined, img.title ?? undefined);
      }
      return paragraph(convertInlineNodes(node.children));

    case 'blockquote':
      return blockquote(convertBlockChildren(node.children));

    case 'code':
      return codeBlock(node.lang ?? null, node.value);

    case 'list': {
      const items = node.children.map((li) => {
        const content = convertBlockChildren(li.children);
        return listItem(content);
      });
      return node.ordered ? orderedList(items) : bulletList(items);
    }

    case 'thematicBreak':
      return horizontalRule();

    case 'html':
      // Paywall marker detection
      if (PAYWALL_MARKER.test(node.value.trim())) {
        return paywall();
      }
      // Other raw HTML — wrap as a paragraph with the raw text
      return paragraph([text(node.value)]);

    default:
      // Unsupported node types are silently dropped
      return null;
  }
}

/**
 * Convert an array of mdast block children (inside blockquote, list items, etc.).
 */
function convertBlockChildren(children: RootContent[]): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  for (const child of children) {
    pushConverted(nodes, convertBlockNode(child));
  }
  return nodes;
}

// ── Inline node conversion ─────────────────────────────────────

/**
 * Convert mdast phrasing (inline) content to ProseMirror text nodes
 * with the appropriate marks applied.
 */
function convertInlineNodes(
  children: PhrasingContent[],
  inheritedMarks: ProseMirrorMark[] = [],
): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];

  for (const child of children) {
    switch (child.type) {
      case 'text':
        nodes.push(text(child.value, inheritedMarks.length > 0 ? [...inheritedMarks] : undefined));
        break;

      case 'strong':
        nodes.push(
          ...convertInlineNodes(child.children, [...inheritedMarks, boldMark()]),
        );
        break;

      case 'emphasis':
        nodes.push(
          ...convertInlineNodes(child.children, [...inheritedMarks, italicMark()]),
        );
        break;

      case 'delete':
        nodes.push(
          ...convertInlineNodes(
            child.children,
            [...inheritedMarks, strikethroughMark()],
          ),
        );
        break;

      case 'inlineCode':
        nodes.push(text(child.value, [...inheritedMarks, codeMark()]));
        break;

      case 'link':
        nodes.push(
          ...convertInlineNodes(
            child.children,
            [...inheritedMarks, linkMark(child.url)],
          ),
        );
        break;

      case 'image':
        // Inline images — rare, but handle by promoting to text alt
        nodes.push(image(child.url, child.alt ?? undefined, child.title ?? undefined));
        break;

      case 'break':
        // Hard line break — Substack renders these as newlines in text
        nodes.push(text('\n', inheritedMarks.length > 0 ? [...inheritedMarks] : undefined));
        break;

      case 'html':
        // Inline HTML — check for paywall, otherwise render as text
        if (PAYWALL_MARKER.test(child.value.trim())) {
          nodes.push(paywall());
        } else {
          nodes.push(text(child.value, inheritedMarks.length > 0 ? [...inheritedMarks] : undefined));
        }
        break;

      default:
        // Unsupported inline types silently dropped
        break;
    }
  }

  return nodes;
}

// ── Helpers ────────────────────────────────────────────────────

/** Push a converted block result (single node, array, or null) into an output array. */
function pushConverted(target: ProseMirrorNode[], result: ProseMirrorNode | ProseMirrorNode[] | null): void {
  if (!result) return;
  if (Array.isArray(result)) {
    target.push(...result);
  } else {
    target.push(result);
  }
}

/**
 * Extract plain text from phrasing content nodes (for title comparison).
 */
function extractPlainText(children: PhrasingContent[]): string {
  let result = '';
  for (const child of children) {
    if (child.type === 'text' || child.type === 'inlineCode') {
      result += child.value;
    } else if ('children' in child) {
      result += extractPlainText(child.children as PhrasingContent[]);
    }
  }
  return result;
}
