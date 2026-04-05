import type { SubstackHTTP } from './http.js';
import type {
  SubstackDraft,
  SubstackPost,
  SubstackSection,
  SubstackTag,
  SubstackUser,
} from '../types.js';

/** Raw subscription entry from the /subscriptions endpoint. */
interface SubscriptionEntry {
  id: number;
  name: string;
  slug: string;
  type?: string;
  publication?: {
    hostname?: string;
    custom_domain?: string;
    base_url?: string;
  };
}

/** Raw launch checklist response from /publication_launch_checklist. */
interface LaunchChecklist {
  subscriber_count?: number;
  total_subscribers?: number;
  subscribers?: number;
  [key: string]: unknown;
}

/**
 * Read-only operations against the Substack API.
 *
 * Always available regardless of SUBSTACK_ENABLE_WRITE setting.
 * All methods are unauthenticated-safe where possible, falling back
 * to session auth for draft/subscriber endpoints.
 *
 * Uses lazy-fetch caching (NHagar pattern): results are cached in private
 * fields and returned on subsequent calls. Pass `force_refresh: true` to
 * bypass the cache and re-fetch from the API.
 */
export class SubstackReader {
  private readonly http: SubstackHTTP;

  // Lazy-fetch caches
  private cachedSubscriberCount: number | null = null;
  private cachedSections: SubstackSection[] | null = null;
  private cachedTags: SubstackTag[] | null = null;
  private cachedUsers: SubstackUser[] | null = null;

  constructor(http: SubstackHTTP) {
    this.http = http;
  }

  /**
   * List published posts, newest first.
   *
   * Supports pagination via `offset` and `limit`. Results are not cached
   * since pagination parameters produce different result sets.
   */
  async listPublished(options?: {
    offset?: number;
    limit?: number;
  }): Promise<SubstackPost[]> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 25;
    const path =
      `/post_management/published` +
      `?offset=${offset}&limit=${limit}` +
      `&order_by=post_date&order_direction=desc`;
    return this.http.get<SubstackPost[]>(path);
  }

  /**
   * List drafts for the authenticated user.
   *
   * Supports pagination via `offset` and `limit`. Results are not cached
   * since pagination parameters produce different result sets.
   */
  async listDrafts(options?: {
    offset?: number;
    limit?: number;
  }): Promise<SubstackDraft[]> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 25;
    const path = `/drafts?filter=&offset=${offset}&limit=${limit}`;
    return this.http.get<SubstackDraft[]>(path);
  }

  /**
   * Fetch a single draft by ID, including the full body.
   *
   * Not cached — each call fetches the latest version.
   */
  async getDraft(id: number): Promise<SubstackDraft> {
    return this.http.get<SubstackDraft>(`/drafts/${id}`);
  }

  /**
   * Get the current subscriber count for the publication.
   *
   * Extracted from the publication launch checklist response.
   * Cached after first fetch; pass `force_refresh` to re-fetch.
   */
  async getSubscriberCount(options?: {
    force_refresh?: boolean;
  }): Promise<number> {
    if (this.cachedSubscriberCount !== null && !options?.force_refresh) {
      return this.cachedSubscriberCount;
    }

    const checklist = await this.http.get<LaunchChecklist>(
      '/publication_launch_checklist',
    );

    const count =
      checklist.subscriber_count ??
      checklist.total_subscribers ??
      checklist.subscribers ??
      0;

    this.cachedSubscriberCount = count;
    return count;
  }

  /**
   * List all sections (categories) on the publication.
   *
   * Fetches subscription data and filters to entries that belong to
   * the current publication's hostname. Cached after first fetch;
   * pass `force_refresh` to re-fetch.
   */
  async getSections(options?: {
    force_refresh?: boolean;
  }): Promise<SubstackSection[]> {
    if (this.cachedSections !== null && !options?.force_refresh) {
      return this.cachedSections;
    }

    const subscriptions =
      await this.http.get<SubscriptionEntry[]>('/subscriptions');

    // Extract the publication hostname from the HTTP client's base URL
    // to filter subscriptions down to sections for this publication.
    const pubHostname = this.extractHostname();

    const sections: SubstackSection[] = subscriptions
      .filter((sub) => {
        const subHost =
          sub.publication?.hostname ??
          sub.publication?.custom_domain ??
          '';
        return subHost === pubHostname || sub.type === 'section';
      })
      .map((sub) => ({
        id: sub.id,
        name: sub.name,
        slug: sub.slug,
      }));

    this.cachedSections = sections;
    return sections;
  }

  /**
   * List all tags on the publication.
   *
   * Cached after first fetch; pass `force_refresh` to re-fetch.
   */
  async getTags(options?: {
    force_refresh?: boolean;
  }): Promise<SubstackTag[]> {
    if (this.cachedTags !== null && !options?.force_refresh) {
      return this.cachedTags;
    }

    const tags = await this.http.get<SubstackTag[]>('/publication/post-tag');
    this.cachedTags = tags;
    return tags;
  }

  /**
   * List all users (authors, editors) on the publication.
   *
   * Cached after first fetch; pass `force_refresh` to re-fetch.
   */
  async getPublicationUsers(options?: {
    force_refresh?: boolean;
  }): Promise<SubstackUser[]> {
    if (this.cachedUsers !== null && !options?.force_refresh) {
      return this.cachedUsers;
    }

    const users = await this.http.get<SubstackUser[]>('/publication/users');
    this.cachedUsers = users;
    return users;
  }

  /**
   * Extract the hostname from the HTTP client's base URL.
   * Used to filter subscription entries to the current publication.
   */
  private extractHostname(): string {
    // Access the base URL via a test request URL and parse it
    const testUrl = this.http.url('/');
    try {
      const parsed = new URL(testUrl);
      return parsed.hostname;
    } catch {
      return '';
    }
  }
}
