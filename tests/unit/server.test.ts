import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubstackConfig } from '../../src/types.js';

// Mock the HTTP, Reader, and Writer classes so createServer doesn't make real calls
vi.mock('../../src/client/http.js', () => ({
  SubstackHTTP: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
    url: vi.fn((path: string) => `https://test.substack.com/api/v1${path}`),
  })),
}));

const mockReader = {
  listPublished: vi.fn(),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  getSubscriberCount: vi.fn(),
  getSections: vi.fn(),
  getTags: vi.fn(),
  getPublicationUsers: vi.fn(),
};

vi.mock('../../src/client/reader.js', () => ({
  SubstackReader: vi.fn().mockImplementation(() => mockReader),
}));

const mockWriter = {
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  deleteDraft: vi.fn(),
  publishDraft: vi.fn(),
  scheduleDraft: vi.fn(),
  unscheduleDraft: vi.fn(),
  uploadImage: vi.fn(),
  createTag: vi.fn(),
  applyTag: vi.fn(),
};

vi.mock('../../src/client/writer.js', () => ({
  SubstackWriter: vi.fn().mockImplementation(() => mockWriter),
}));

import { createServer } from '../../src/server.js';

function makeConfig(overrides?: Partial<SubstackConfig>): SubstackConfig {
  return {
    publicationUrl: 'https://test.substack.com',
    sessionToken: 'test-token',
    enableWrite: false,
    rateLimitPerSecond: 1,
    maxRetries: 3,
    ...overrides,
  };
}

/**
 * Extract registered tool names from an McpServer instance.
 * _registeredTools is a plain object keyed by tool name.
 */
function getToolNames(config: SubstackConfig): string[] {
  const server = createServer(config);
  const serverAny = server as any;
  return Object.keys(serverAny._registeredTools ?? {});
}

/**
 * Get the handler function for a specific tool.
 * Each entry in _registeredTools has a `handler` property.
 */
function getToolHandler(config: SubstackConfig, toolName: string): (args: any, extra: any) => Promise<any> {
  const server = createServer(config);
  const serverAny = server as any;
  const entry = serverAny._registeredTools?.[toolName];
  if (!entry?.handler) {
    throw new Error(`Tool "${toolName}" not found or has no handler`);
  }
  return entry.handler;
}

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tool registration', () => {
    it('registers read tools when write is disabled', () => {
      const tools = getToolNames(makeConfig({ enableWrite: false }));

      const readTools = [
        'list_published',
        'list_drafts',
        'get_draft',
        'get_subscriber_count',
        'get_sections',
        'preview_draft',
      ];

      for (const tool of readTools) {
        expect(tools).toContain(tool);
      }
    });

    it('does NOT register write tools when write is disabled', () => {
      const tools = getToolNames(makeConfig({ enableWrite: false }));

      const writeTools = [
        'create_draft',
        'update_draft',
        'delete_draft',
        'publish_draft',
        'schedule_draft',
        'upload_image',
      ];

      for (const tool of writeTools) {
        expect(tools).not.toContain(tool);
      }
    });

    it('registers write tools when write is enabled', () => {
      const tools = getToolNames(makeConfig({ enableWrite: true }));

      const writeTools = [
        'create_draft',
        'update_draft',
        'delete_draft',
        'publish_draft',
        'schedule_draft',
        'upload_image',
      ];

      for (const tool of writeTools) {
        expect(tools).toContain(tool);
      }
    });

    it('also registers read tools when write is enabled', () => {
      const tools = getToolNames(makeConfig({ enableWrite: true }));

      expect(tools).toContain('list_published');
      expect(tools).toContain('list_drafts');
      expect(tools).toContain('get_draft');
    });
  });

  describe('confirmation gates', () => {
    it('delete_draft with confirm_delete=false returns preview with nonce', async () => {
      mockReader.getDraft.mockResolvedValue({
        id: 1,
        draft_title: 'Test Draft',
        draft_subtitle: '',
        draft_body: JSON.stringify({ type: 'doc', content: [] }),
      });

      const handler = getToolHandler(makeConfig({ enableWrite: true }), 'delete_draft');
      const result = await handler({ draft_id: '1', confirm_delete: false }, {});

      const text = result.content[0].text;
      expect(text).toContain('DELETE');
      expect(text).toContain('confirm_delete=true');
      expect(text).toContain('confirmation_nonce=');
      expect(mockWriter.deleteDraft).not.toHaveBeenCalled();
    });

    it('delete_draft with confirm_delete=true and valid nonce executes deletion', async () => {
      mockReader.getDraft.mockResolvedValue({
        id: 1,
        draft_title: 'Test Draft',
        draft_subtitle: '',
        draft_body: JSON.stringify({ type: 'doc', content: [] }),
      });
      mockWriter.deleteDraft.mockResolvedValue(undefined);

      // Must use the same server instance for nonce to persist
      const config = makeConfig({ enableWrite: true });
      const server = createServer(config);
      const serverAny = server as any;
      const handler = serverAny._registeredTools?.['delete_draft']?.handler;

      // Step 1: get preview and nonce
      const previewResult = await handler({ draft_id: '1', confirm_delete: false }, {});
      const nonceMatch = previewResult.content[0].text.match(/confirmation_nonce="([a-f0-9]+)"/);
      expect(nonceMatch).not.toBeNull();
      const nonce = nonceMatch![1];

      // Step 2: confirm with nonce
      const result = await handler({ draft_id: '1', confirm_delete: true, confirmation_nonce: nonce }, {});

      expect(mockWriter.deleteDraft).toHaveBeenCalledWith(1);
      expect(result.content[0].text).toContain('deleted successfully');
    });

    it('delete_draft rejects confirm without valid nonce', async () => {
      const handler = getToolHandler(makeConfig({ enableWrite: true }), 'delete_draft');
      const result = await handler({ draft_id: '1', confirm_delete: true, confirmation_nonce: 'invalid' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid or expired confirmation nonce');
      expect(mockWriter.deleteDraft).not.toHaveBeenCalled();
    });

    it('publish_draft with confirm_publish=false returns preview with nonce', async () => {
      mockReader.getDraft.mockResolvedValue({
        id: 1,
        draft_title: 'My Post',
        draft_subtitle: 'Subtitle',
        draft_body: JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        }),
      });

      const handler = getToolHandler(makeConfig({ enableWrite: true }), 'publish_draft');
      const result = await handler({
        draft_id: '1',
        send_email: true,
        confirm_publish: false,
      }, {});

      const text = result.content[0].text;
      expect(text).toContain('PUBLISH');
      expect(text).toContain('confirm_publish=true');
      expect(text).toContain('confirmation_nonce=');
      expect(mockWriter.publishDraft).not.toHaveBeenCalled();
    });

    it('publish_draft with confirm_publish=true and valid nonce executes publishing', async () => {
      mockReader.getDraft.mockResolvedValue({
        id: 1,
        draft_title: 'My Post',
        draft_subtitle: 'Subtitle',
        draft_body: JSON.stringify({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
        }),
      });
      mockWriter.publishDraft.mockResolvedValue({
        id: 1,
        title: 'My Post',
        canonical_url: 'https://test.substack.com/p/my-post',
      });

      // Must use the same server instance for nonce to persist
      const config = makeConfig({ enableWrite: true });
      const server = createServer(config);
      const serverAny = server as any;
      const handler = serverAny._registeredTools?.['publish_draft']?.handler;

      // Step 1: get preview and nonce
      const previewResult = await handler({
        draft_id: '1',
        send_email: true,
        confirm_publish: false,
      }, {});
      const nonceMatch = previewResult.content[0].text.match(/confirmation_nonce="([a-f0-9]+)"/);
      expect(nonceMatch).not.toBeNull();
      const nonce = nonceMatch![1];

      // Step 2: confirm with nonce
      const result = await handler({
        draft_id: '1',
        send_email: true,
        confirm_publish: true,
        confirmation_nonce: nonce,
      }, {});

      expect(mockWriter.publishDraft).toHaveBeenCalledWith(1, {
        send: true,
        shareAutomatically: false,
      });
      const text = result.content[0].text;
      expect(text).toContain('published successfully');
    });
  });

  describe('error handling', () => {
    it('returns isError=true when a tool throws', async () => {
      mockReader.listPublished.mockRejectedValue(new Error('connection failed'));

      const handler = getToolHandler(makeConfig(), 'list_published');
      const result = await handler({}, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('connection failed');
    });

    it('handles non-Error thrown values', async () => {
      mockReader.listDrafts.mockRejectedValue('string error');

      const handler = getToolHandler(makeConfig(), 'list_drafts');
      const result = await handler({}, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('string error');
    });

    it('returns error for invalid draft_id in get_draft', async () => {
      const handler = getToolHandler(makeConfig(), 'get_draft');
      const result = await handler({ draft_id: 'abc' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid');
    });
  });
});
