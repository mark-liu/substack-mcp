import { describe, it, expect } from 'vitest';
import { markdownToProseMirror } from '../../src/converters/markdown.js';

describe('markdownToProseMirror', () => {
  // ── Basic block elements ────────────────────────────────────

  it('converts a simple paragraph', () => {
    const doc = markdownToProseMirror('Hello world');
    expect(doc.type).toBe('doc');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('paragraph');
    expect(doc.content[0].content![0].text).toBe('Hello world');
  });

  it('converts multiple paragraphs', () => {
    const doc = markdownToProseMirror('First paragraph.\n\nSecond paragraph.');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].content![0].text).toBe('First paragraph.');
    expect(doc.content[1].content![0].text).toBe('Second paragraph.');
  });

  it('converts headings h1 through h6', () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = '#'.repeat(level);
      const doc = markdownToProseMirror(`${hashes} Heading ${level}`);
      expect(doc.content).toHaveLength(1);
      expect(doc.content[0].type).toBe('heading');
      expect(doc.content[0].attrs).toEqual({ level });
      expect(doc.content[0].content![0].text).toBe(`Heading ${level}`);
    }
  });

  // ── Inline marks ────────────────────────────────────────────

  it('converts bold text', () => {
    const doc = markdownToProseMirror('Some **bold** text');
    const para = doc.content[0];
    const boldNode = para.content!.find((n) => n.text === 'bold');
    expect(boldNode).toBeDefined();
    expect(boldNode!.marks).toContainEqual({ type: 'bold' });
  });

  it('converts italic text', () => {
    const doc = markdownToProseMirror('Some *italic* text');
    const para = doc.content[0];
    const italicNode = para.content!.find((n) => n.text === 'italic');
    expect(italicNode).toBeDefined();
    expect(italicNode!.marks).toContainEqual({ type: 'italic' });
  });

  it('converts inline code', () => {
    const doc = markdownToProseMirror('Use `code` here');
    const para = doc.content[0];
    const codeNode = para.content!.find((n) => n.text === 'code');
    expect(codeNode).toBeDefined();
    expect(codeNode!.marks).toContainEqual({ type: 'code' });
  });

  it('converts links', () => {
    const doc = markdownToProseMirror('Click [here](https://example.com)');
    const para = doc.content[0];
    const linkNode = para.content!.find((n) => n.text === 'here');
    expect(linkNode).toBeDefined();
    expect(linkNode!.marks).toContainEqual({
      type: 'link',
      attrs: {
        href: 'https://example.com',
        target: '_blank',
        rel: 'nofollow ugc noopener',
      },
    });
  });

  it('converts nested marks: bold inside italic', () => {
    const doc = markdownToProseMirror('*text **both** text*');
    const para = doc.content[0];
    const bothNode = para.content!.find((n) => n.text === 'both');
    expect(bothNode).toBeDefined();
    expect(bothNode!.marks).toContainEqual({ type: 'italic' });
    expect(bothNode!.marks).toContainEqual({ type: 'bold' });
  });

  it('converts bold inside link', () => {
    const doc = markdownToProseMirror('[**bold link**](https://example.com)');
    const para = doc.content[0];
    const boldLinkNode = para.content!.find((n) => n.text === 'bold link');
    expect(boldLinkNode).toBeDefined();
    const markTypes = boldLinkNode!.marks!.map((m) => m.type);
    expect(markTypes).toContain('link');
    expect(markTypes).toContain('bold');
  });

  // ── Lists ───────────────────────────────────────────────────

  it('converts bullet list', () => {
    const doc = markdownToProseMirror('- item 1\n- item 2\n- item 3');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('bullet_list');
    expect(doc.content[0].content).toHaveLength(3);
    doc.content[0].content!.forEach((item) => {
      expect(item.type).toBe('list_item');
    });
  });

  it('converts ordered list', () => {
    const doc = markdownToProseMirror('1. first\n2. second');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('ordered_list');
    expect(doc.content[0].attrs).toEqual({ order: 1 });
    expect(doc.content[0].content).toHaveLength(2);
  });

  // ── Code blocks ─────────────────────────────────────────────

  it('converts fenced code block with language', () => {
    const doc = markdownToProseMirror('```typescript\nconst x = 1;\n```');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('codeBlock');
    expect(doc.content[0].attrs).toEqual({ params: 'typescript' });
    expect(doc.content[0].content![0].text).toBe('const x = 1;');
  });

  it('converts fenced code block without language', () => {
    const doc = markdownToProseMirror('```\nplain code\n```');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('codeBlock');
    // No language means attrs is undefined (null passed to codeBlock factory)
    expect(doc.content[0].attrs).toBeUndefined();
  });

  // ── Blockquotes ─────────────────────────────────────────────

  it('converts blockquotes', () => {
    const doc = markdownToProseMirror('> This is quoted');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('blockquote');
    expect(doc.content[0].content![0].type).toBe('paragraph');
  });

  // ── Horizontal rules ───────────────────────────────────────

  it('converts horizontal rules', () => {
    const doc = markdownToProseMirror('Above\n\n---\n\nBelow');
    const hr = doc.content.find((n) => n.type === 'horizontal_rule');
    expect(hr).toBeDefined();
  });

  // ── Images ──────────────────────────────────────────────────

  it('converts images to captionedImage structure', () => {
    const doc = markdownToProseMirror('![alt text](https://example.com/img.png "title")');
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('captionedImage');
    const img = doc.content[0].content![0];
    expect(img.type).toBe('image2');
    expect(img.attrs!['src']).toBe('https://example.com/img.png');
    expect(img.attrs!['alt']).toBe('alt text');
    expect(img.attrs!['title']).toBe('title');
  });

  // ── Paywall marker ─────────────────────────────────────────

  it('converts <!-- PAYWALL --> to paywall node', () => {
    const doc = markdownToProseMirror('Free content\n\n<!-- PAYWALL -->\n\nPaid content');
    const paywallNode = doc.content.find((n) => n.type === 'paywall');
    expect(paywallNode).toBeDefined();
  });

  it('handles case-insensitive paywall marker', () => {
    const doc = markdownToProseMirror('<!-- paywall -->');
    const paywallNode = doc.content.find((n) => n.type === 'paywall');
    expect(paywallNode).toBeDefined();
  });

  // ── Duplicate title detection ──────────────────────────────

  it('skips H1 that matches the title parameter', () => {
    const doc = markdownToProseMirror('# My Article\n\nBody text', 'My Article');
    // The heading should be stripped, only body remains
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('paragraph');
    expect(doc.content[0].content![0].text).toBe('Body text');
  });

  it('keeps H1 that does not match the title parameter', () => {
    const doc = markdownToProseMirror('# Different Title\n\nBody text', 'My Article');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].type).toBe('heading');
  });

  it('keeps H1 when no title parameter is provided', () => {
    const doc = markdownToProseMirror('# My Title\n\nBody text');
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].type).toBe('heading');
  });

  // ── Complex document ───────────────────────────────────────

  it('converts a complex mixed-content document', () => {
    const md = [
      '## Introduction',
      '',
      'This is a **bold** and *italic* paragraph.',
      '',
      '- bullet 1',
      '- bullet 2',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      '> A quote',
      '',
      '---',
      '',
      '![img](https://example.com/img.png)',
      '',
      '<!-- PAYWALL -->',
      '',
      'Paid section.',
    ].join('\n');

    const doc = markdownToProseMirror(md);
    const types = doc.content.map((n) => n.type);

    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('bullet_list');
    expect(types).toContain('codeBlock');
    expect(types).toContain('blockquote');
    expect(types).toContain('horizontal_rule');
    expect(types).toContain('captionedImage');
    expect(types).toContain('paywall');
  });

  // ── Empty input ────────────────────────────────────────────

  it('returns empty doc for empty input', () => {
    const doc = markdownToProseMirror('');
    expect(doc.type).toBe('doc');
    expect(doc.content).toHaveLength(0);
  });

  it('returns empty doc for whitespace-only input', () => {
    const doc = markdownToProseMirror('   \n\n   ');
    expect(doc.type).toBe('doc');
    expect(doc.content).toHaveLength(0);
  });
});
