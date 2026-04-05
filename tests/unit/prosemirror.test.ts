import { describe, it, expect } from 'vitest';
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
} from '../../src/converters/prosemirror.js';

// ── Mark constructors ─────────────────────────────────────────

describe('boldMark', () => {
  it('returns type bold with no attrs', () => {
    expect(boldMark()).toEqual({ type: 'bold' });
  });
});

describe('italicMark', () => {
  it('returns type italic with no attrs', () => {
    expect(italicMark()).toEqual({ type: 'italic' });
  });
});

describe('strikethroughMark', () => {
  it('returns type strikethrough with no attrs', () => {
    expect(strikethroughMark()).toEqual({ type: 'strikethrough' });
  });
});

describe('codeMark', () => {
  it('returns type code with no attrs', () => {
    expect(codeMark()).toEqual({ type: 'code' });
  });
});

describe('linkMark', () => {
  it('returns type link with href, target, and rel attrs', () => {
    const mark = linkMark('https://example.com');
    expect(mark).toEqual({
      type: 'link',
      attrs: {
        href: 'https://example.com',
        target: '_blank',
        rel: 'nofollow ugc noopener',
      },
    });
  });
});

// ── Block node constructors ───────────────────────────────────

describe('paragraph', () => {
  it('wraps content in a paragraph node', () => {
    const node = paragraph([text('hello')]);
    expect(node.type).toBe('paragraph');
    expect(node.content).toHaveLength(1);
    expect(node.content![0].text).toBe('hello');
  });
});

describe('heading', () => {
  it.each([1, 2, 3, 4, 5, 6] as const)('creates h%i heading', (level) => {
    const node = heading(level, [text(`Level ${level}`)]);
    expect(node.type).toBe('heading');
    expect(node.attrs).toEqual({ level });
    expect(node.content).toHaveLength(1);
    expect(node.content![0].text).toBe(`Level ${level}`);
  });
});

describe('codeBlock', () => {
  it('creates code block with language', () => {
    const node = codeBlock('typescript', 'const x = 1;');
    expect(node.type).toBe('codeBlock');
    expect(node.attrs).toEqual({ params: 'typescript' });
    expect(node.content).toEqual([{ type: 'text', text: 'const x = 1;' }]);
  });

  it('creates code block without language (null)', () => {
    const node = codeBlock(null, 'plain text');
    expect(node.type).toBe('codeBlock');
    expect(node.attrs).toBeUndefined();
    expect(node.content).toEqual([{ type: 'text', text: 'plain text' }]);
  });
});

describe('blockquote', () => {
  it('wraps content in a blockquote node', () => {
    const node = blockquote([paragraph([text('quoted')])]);
    expect(node.type).toBe('blockquote');
    expect(node.content).toHaveLength(1);
    expect(node.content![0].type).toBe('paragraph');
  });
});

describe('bulletList', () => {
  it('creates an unordered list', () => {
    const items = [listItem([paragraph([text('a')])])];
    const node = bulletList(items);
    expect(node.type).toBe('bullet_list');
    expect(node.content).toHaveLength(1);
  });
});

describe('orderedList', () => {
  it('creates an ordered list with order=1', () => {
    const items = [listItem([paragraph([text('first')])])];
    const node = orderedList(items);
    expect(node.type).toBe('ordered_list');
    expect(node.attrs).toEqual({ order: 1 });
    expect(node.content).toHaveLength(1);
  });
});

describe('listItem', () => {
  it('wraps content in a list_item node', () => {
    const node = listItem([paragraph([text('item')])]);
    expect(node.type).toBe('list_item');
    expect(node.content).toHaveLength(1);
  });
});

describe('horizontalRule', () => {
  it('returns a horizontal_rule node with no content or attrs', () => {
    const node = horizontalRule();
    expect(node).toEqual({ type: 'horizontal_rule' });
  });
});

describe('image', () => {
  it('creates captionedImage > image2 structure', () => {
    const node = image('https://example.com/img.png');
    expect(node.type).toBe('captionedImage');
    expect(node.content).toHaveLength(1);
    expect(node.content![0].type).toBe('image2');
    expect(node.content![0].attrs).toEqual({
      src: 'https://example.com/img.png',
      fullscreen: true,
      imageSize: 'normal',
    });
  });

  it('includes alt and title when provided', () => {
    const node = image('https://example.com/img.png', 'alt text', 'title text');
    const attrs = node.content![0].attrs!;
    expect(attrs['alt']).toBe('alt text');
    expect(attrs['title']).toBe('title text');
  });

  it('omits alt and title when not provided', () => {
    const node = image('https://example.com/img.png');
    const attrs = node.content![0].attrs!;
    expect(attrs).not.toHaveProperty('alt');
    expect(attrs).not.toHaveProperty('title');
  });
});

describe('paywall', () => {
  it('returns a paywall node with no content or attrs', () => {
    expect(paywall()).toEqual({ type: 'paywall' });
  });
});

// ── Inline node constructor ───────────────────────────────────

describe('text', () => {
  it('creates a plain text node with no marks', () => {
    const node = text('hello');
    expect(node).toEqual({ type: 'text', text: 'hello' });
    expect(node.marks).toBeUndefined();
  });

  it('attaches marks when provided', () => {
    const node = text('bold text', [boldMark()]);
    expect(node.marks).toEqual([{ type: 'bold' }]);
  });

  it('does not attach marks when array is empty', () => {
    const node = text('plain', []);
    expect(node.marks).toBeUndefined();
  });

  it('supports multiple marks', () => {
    const node = text('fancy', [boldMark(), italicMark(), linkMark('https://example.com')]);
    expect(node.marks).toHaveLength(3);
    expect(node.marks![0].type).toBe('bold');
    expect(node.marks![1].type).toBe('italic');
    expect(node.marks![2].type).toBe('link');
  });
});
