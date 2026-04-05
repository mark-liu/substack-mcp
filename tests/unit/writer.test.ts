import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubstackWriter } from '../../src/client/writer.js';
import { SubstackError } from '../../src/errors.js';
import type { SubstackHTTP } from '../../src/client/http.js';
import type { ProseMirrorDoc } from '../../src/types.js';

function makeMockHttp(): SubstackHTTP {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
    url: vi.fn(),
  } as unknown as SubstackHTTP;
}

function makeSimpleDoc(): ProseMirrorDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    ],
  };
}

describe('SubstackWriter', () => {
  let http: SubstackHTTP;
  let writer: SubstackWriter;

  beforeEach(() => {
    http = makeMockHttp();
    writer = new SubstackWriter(http);
  });

  // ── createDraft ─────────────────────────────────────────────

  describe('createDraft', () => {
    it('posts correctly serialized ProseMirror body', async () => {
      const mockDraft = { id: 1, draft_title: 'Test' };
      vi.mocked(http.post).mockResolvedValue(mockDraft);

      const doc = makeSimpleDoc();
      const result = await writer.createDraft('Test', doc);

      expect(result).toEqual(mockDraft);
      expect(http.post).toHaveBeenCalledWith('/drafts', {
        draft_title: 'Test',
        draft_body: JSON.stringify(doc),
        audience: 'everyone',
        type: 'newsletter',
      });
    });

    it('includes subtitle and audience when provided', async () => {
      vi.mocked(http.post).mockResolvedValue({ id: 1 });

      await writer.createDraft('Title', makeSimpleDoc(), {
        subtitle: 'My subtitle',
        audience: 'only_paid',
      });

      const payload = vi.mocked(http.post).mock.calls[0][1] as Record<string, unknown>;
      expect(payload['draft_subtitle']).toBe('My subtitle');
      expect(payload['audience']).toBe('only_paid');
    });

    it('includes draft_bylines when userId is provided', async () => {
      vi.mocked(http.post).mockResolvedValue({ id: 1 });

      await writer.createDraft('Title', makeSimpleDoc(), { userId: 42 });

      const payload = vi.mocked(http.post).mock.calls[0][1] as Record<string, unknown>;
      expect(payload['draft_bylines']).toEqual([{ id: 42 }]);
    });

    it('rejects empty title', async () => {
      await expect(writer.createDraft('', makeSimpleDoc())).rejects.toThrow(SubstackError);
      await expect(writer.createDraft('   ', makeSimpleDoc())).rejects.toThrow(SubstackError);
    });

    it('rejects body over 500KB', async () => {
      const bigDoc: ProseMirrorDoc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }],
          },
        ],
      };

      await expect(writer.createDraft('Title', bigDoc)).rejects.toThrow(/500 KB/);
    });
  });

  // ── updateDraft ─────────────────────────────────────────────

  describe('updateDraft', () => {
    it('maps camelCase to snake_case fields', async () => {
      vi.mocked(http.put).mockResolvedValue({ id: 1 });

      await writer.updateDraft(1, {
        title: 'New Title',
        subtitle: 'New Subtitle',
        searchEngineTitle: 'SEO Title',
        searchEngineDescription: 'SEO Desc',
      });

      const payload = vi.mocked(http.put).mock.calls[0][1] as Record<string, unknown>;
      expect(payload['draft_title']).toBe('New Title');
      expect(payload['draft_subtitle']).toBe('New Subtitle');
      expect(payload['search_engine_title']).toBe('SEO Title');
      expect(payload['search_engine_description']).toBe('SEO Desc');
    });

    it('validates draftId is a positive integer', async () => {
      await expect(writer.updateDraft(0, { title: 'X' })).rejects.toThrow(SubstackError);
      await expect(writer.updateDraft(-1, { title: 'X' })).rejects.toThrow(SubstackError);
      await expect(writer.updateDraft(1.5, { title: 'X' })).rejects.toThrow(SubstackError);
    });

    it('validates sectionId when provided', async () => {
      await expect(writer.updateDraft(1, { sectionId: -1 })).rejects.toThrow(SubstackError);
    });

    it('allows sectionId null (unassign section)', async () => {
      vi.mocked(http.put).mockResolvedValue({ id: 1 });

      await writer.updateDraft(1, { sectionId: null });

      const payload = vi.mocked(http.put).mock.calls[0][1] as Record<string, unknown>;
      expect(payload['section_id']).toBeNull();
    });

    it('throws when no update fields provided', async () => {
      await expect(writer.updateDraft(1, {})).rejects.toThrow('No update fields provided');
    });
  });

  // ── deleteDraft ─────────────────────────────────────────────

  describe('deleteDraft', () => {
    it('sends DELETE to correct path', async () => {
      vi.mocked(http.delete).mockResolvedValue(undefined);

      await writer.deleteDraft(42);
      expect(http.delete).toHaveBeenCalledWith('/drafts/42');
    });

    it('validates draftId', async () => {
      await expect(writer.deleteDraft(0)).rejects.toThrow(SubstackError);
      await expect(writer.deleteDraft(-5)).rejects.toThrow(SubstackError);
    });
  });

  // ── publishDraft ────────────────────────────────────────────

  describe('publishDraft', () => {
    it('calls prepublish then publish', async () => {
      vi.mocked(http.get).mockResolvedValue({ errors: [] });
      vi.mocked(http.post).mockResolvedValue({ id: 1, title: 'Published' });

      const result = await writer.publishDraft(1, {
        send: true,
        shareAutomatically: false,
      });

      expect(http.get).toHaveBeenCalledWith('/drafts/1/prepublish');
      expect(http.post).toHaveBeenCalledWith('/drafts/1/publish', {
        send: true,
        share_automatically: false,
      });
      expect(result).toEqual({ id: 1, title: 'Published' });
    });

    it('throws when prepublish returns errors', async () => {
      vi.mocked(http.get).mockResolvedValue({
        errors: ['Missing cover image', 'Title too short'],
      });

      await expect(
        writer.publishDraft(1, { send: true, shareAutomatically: false }),
      ).rejects.toThrow('Pre-publish validation failed');
    });

    it('validates draftId', async () => {
      await expect(
        writer.publishDraft(0, { send: true, shareAutomatically: false }),
      ).rejects.toThrow(SubstackError);
    });
  });

  // ── scheduleDraft ───────────────────────────────────────────

  describe('scheduleDraft', () => {
    it('posts schedule with ISO date', async () => {
      vi.mocked(http.post).mockResolvedValue(undefined);

      const futureDate = new Date(Date.now() + 86_400_000).toISOString();
      await writer.scheduleDraft(1, { postDate: futureDate });

      expect(http.post).toHaveBeenCalledWith('/drafts/1/schedule', {
        post_date: futureDate,
      });
    });

    it('rejects past dates', async () => {
      const pastDate = '2020-01-01T00:00:00Z';
      await expect(
        writer.scheduleDraft(1, { postDate: pastDate }),
      ).rejects.toThrow('future');
    });

    it('rejects invalid date strings', async () => {
      await expect(
        writer.scheduleDraft(1, { postDate: 'not-a-date' }),
      ).rejects.toThrow('valid ISO 8601');
    });

    it('rejects empty postDate', async () => {
      await expect(
        writer.scheduleDraft(1, { postDate: '' }),
      ).rejects.toThrow(SubstackError);
    });
  });

  // ── unscheduleDraft ─────────────────────────────────────────

  describe('unscheduleDraft', () => {
    it('sends null post_date to unschedule', async () => {
      vi.mocked(http.post).mockResolvedValue(undefined);

      await writer.unscheduleDraft(5);

      expect(http.post).toHaveBeenCalledWith('/drafts/5/schedule', {
        post_date: null,
      });
    });

    it('validates draftId', async () => {
      await expect(writer.unscheduleDraft(0)).rejects.toThrow(SubstackError);
    });
  });

  // ── uploadImage ─────────────────────────────────────────────

  describe('uploadImage', () => {
    it('passes URL source via upload method', async () => {
      vi.mocked(http.upload).mockResolvedValue({ url: 'https://cdn.substack.com/img.png' });

      const result = await writer.uploadImage('https://example.com/photo.jpg');
      expect(result).toBe('https://cdn.substack.com/img.png');
      expect(http.upload).toHaveBeenCalledOnce();
      const [path, formData] = vi.mocked(http.upload).mock.calls[0];
      expect(path).toBe('/image');
      expect(formData).toBeInstanceOf(FormData);
    });

    it('rejects empty source', async () => {
      await expect(writer.uploadImage('')).rejects.toThrow(SubstackError);
      await expect(writer.uploadImage('   ')).rejects.toThrow(SubstackError);
    });

    it('blocks paths outside allowed directories', async () => {
      await expect(
        writer.uploadImage('/etc/passwd.png'),
      ).rejects.toThrow('within the current working directory or home directory');
    });

    it('blocks URL-encoded path sequences', async () => {
      await expect(
        writer.uploadImage('/tmp/%2e%2e/etc/passwd.png'),
      ).rejects.toThrow('URL-encoded sequences');
    });

    it('rejects unsupported file extensions for paths within allowed dirs', async () => {
      // Use process.cwd() to create a path within allowed directories
      const cwd = process.cwd();
      await expect(
        writer.uploadImage(`${cwd}/image.bmp`),
      ).rejects.toThrow('Unsupported image extension');
    });

  });

  // ── createTag ───────────────────────────────────────────────

  describe('createTag', () => {
    it('posts tag name to API', async () => {
      const mockTag = { id: 1, name: 'tech', slug: 'tech' };
      vi.mocked(http.post).mockResolvedValue(mockTag);

      const result = await writer.createTag('tech');
      expect(result).toEqual(mockTag);
      expect(http.post).toHaveBeenCalledWith('/publication/post-tag', { name: 'tech' });
    });

    it('validates non-empty name', async () => {
      await expect(writer.createTag('')).rejects.toThrow(SubstackError);
      await expect(writer.createTag('   ')).rejects.toThrow(SubstackError);
    });
  });

  // ── applyTag ────────────────────────────────────────────────

  describe('applyTag', () => {
    it('posts to correct path', async () => {
      vi.mocked(http.post).mockResolvedValue(undefined);

      await writer.applyTag(10, 20);
      expect(http.post).toHaveBeenCalledWith('/post/10/tag/20');
    });

    it('validates both IDs', async () => {
      await expect(writer.applyTag(0, 1)).rejects.toThrow(SubstackError);
      await expect(writer.applyTag(1, 0)).rejects.toThrow(SubstackError);
      await expect(writer.applyTag(-1, 1)).rejects.toThrow(SubstackError);
      await expect(writer.applyTag(1, -1)).rejects.toThrow(SubstackError);
    });
  });
});
