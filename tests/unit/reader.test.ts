import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubstackReader } from '../../src/client/reader.js';
import type { SubstackHTTP } from '../../src/client/http.js';

function makeMockHttp(): SubstackHTTP {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
    url: vi.fn((path: string) => `https://test.substack.com/api/v1${path}`),
  } as unknown as SubstackHTTP;
}

describe('SubstackReader', () => {
  let http: SubstackHTTP;
  let reader: SubstackReader;

  beforeEach(() => {
    http = makeMockHttp();
    reader = new SubstackReader(http);
  });

  describe('listPublished', () => {
    it('passes correct default query params', async () => {
      vi.mocked(http.get).mockResolvedValue([]);
      await reader.listPublished();

      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('offset=0'),
      );
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('limit=25'),
      );
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('order_by=post_date'),
      );
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('order_direction=desc'),
      );
    });

    it('passes custom offset and limit', async () => {
      vi.mocked(http.get).mockResolvedValue([]);
      await reader.listPublished({ offset: 10, limit: 5 });

      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('offset=10'),
      );
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('limit=5'),
      );
    });

    it('returns posts from API', async () => {
      const mockPosts = [{ id: 1, title: 'Post 1' }];
      vi.mocked(http.get).mockResolvedValue(mockPosts);

      const result = await reader.listPublished();
      expect(result).toEqual(mockPosts);
    });
  });

  describe('listDrafts', () => {
    it('passes correct default query params', async () => {
      vi.mocked(http.get).mockResolvedValue([]);
      await reader.listDrafts();

      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('offset=0'),
      );
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('limit=25'),
      );
    });

    it('passes custom offset and limit', async () => {
      vi.mocked(http.get).mockResolvedValue([]);
      await reader.listDrafts({ offset: 5, limit: 10 });

      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('offset=5'),
      );
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
      );
    });
  });

  describe('getDraft', () => {
    it('fetches draft by ID', async () => {
      const mockDraft = { id: 42, title: 'My Draft' };
      vi.mocked(http.get).mockResolvedValue(mockDraft);

      const result = await reader.getDraft(42);
      expect(result).toEqual(mockDraft);
      expect(http.get).toHaveBeenCalledWith('/drafts/42');
    });
  });

  describe('getSubscriberCount', () => {
    it('extracts subscriber_count from launch checklist', async () => {
      vi.mocked(http.get).mockResolvedValue({ subscriber_count: 1234 });

      const count = await reader.getSubscriberCount();
      expect(count).toBe(1234);
      expect(http.get).toHaveBeenCalledWith('/publication_launch_checklist');
    });

    it('falls back to total_subscribers', async () => {
      vi.mocked(http.get).mockResolvedValue({ total_subscribers: 500 });

      const count = await reader.getSubscriberCount();
      expect(count).toBe(500);
    });

    it('falls back to subscribers', async () => {
      vi.mocked(http.get).mockResolvedValue({ subscribers: 100 });

      const count = await reader.getSubscriberCount();
      expect(count).toBe(100);
    });

    it('returns 0 when no count field is present', async () => {
      vi.mocked(http.get).mockResolvedValue({});

      const count = await reader.getSubscriberCount();
      expect(count).toBe(0);
    });

    it('caches result on second call', async () => {
      vi.mocked(http.get).mockResolvedValue({ subscriber_count: 1234 });

      await reader.getSubscriberCount();
      await reader.getSubscriberCount();

      expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('force_refresh bypasses cache', async () => {
      vi.mocked(http.get)
        .mockResolvedValueOnce({ subscriber_count: 100 })
        .mockResolvedValueOnce({ subscriber_count: 200 });

      const first = await reader.getSubscriberCount();
      const second = await reader.getSubscriberCount({ force_refresh: true });

      expect(first).toBe(100);
      expect(second).toBe(200);
      expect(http.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSections', () => {
    it('filters subscriptions by publication hostname', async () => {
      vi.mocked(http.get).mockResolvedValue([
        { id: 1, name: 'Section A', slug: 'a', publication: { hostname: 'test.substack.com' } },
        { id: 2, name: 'Other', slug: 'b', publication: { hostname: 'other.substack.com' } },
        { id: 3, name: 'Section C', slug: 'c', type: 'section' },
      ]);

      const sections = await reader.getSections();
      expect(sections).toHaveLength(2);
      expect(sections[0]).toEqual({ id: 1, name: 'Section A', slug: 'a' });
      expect(sections[1]).toEqual({ id: 3, name: 'Section C', slug: 'c' });
    });

    it('caches sections on second call', async () => {
      vi.mocked(http.get).mockResolvedValue([]);

      await reader.getSections();
      await reader.getSections();

      expect(http.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTags', () => {
    it('fetches tags from API', async () => {
      const mockTags = [{ id: 1, name: 'tech', slug: 'tech' }];
      vi.mocked(http.get).mockResolvedValue(mockTags);

      const tags = await reader.getTags();
      expect(tags).toEqual(mockTags);
      expect(http.get).toHaveBeenCalledWith('/publication/post-tag');
    });

    it('caches tags on second call', async () => {
      vi.mocked(http.get).mockResolvedValue([]);

      await reader.getTags();
      await reader.getTags();

      expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('force_refresh bypasses cache', async () => {
      vi.mocked(http.get)
        .mockResolvedValueOnce([{ id: 1, name: 'old', slug: 'old' }])
        .mockResolvedValueOnce([{ id: 2, name: 'new', slug: 'new' }]);

      const first = await reader.getTags();
      const second = await reader.getTags({ force_refresh: true });

      expect(first[0].name).toBe('old');
      expect(second[0].name).toBe('new');
      expect(http.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getPublicationUsers', () => {
    it('fetches users and caches', async () => {
      const mockUsers = [{ id: 1, name: 'Author', photo_url: null }];
      vi.mocked(http.get).mockResolvedValue(mockUsers);

      const users = await reader.getPublicationUsers();
      expect(users).toEqual(mockUsers);
      expect(http.get).toHaveBeenCalledWith('/publication/users');

      // Second call uses cache
      await reader.getPublicationUsers();
      expect(http.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('error propagation', () => {
    it('propagates HTTP errors from the underlying client', async () => {
      const err = new Error('connection refused');
      vi.mocked(http.get).mockRejectedValue(err);

      await expect(reader.listPublished()).rejects.toThrow('connection refused');
    });
  });
});
