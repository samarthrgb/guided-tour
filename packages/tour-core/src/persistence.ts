export interface SeenStore {
  hasSeen(userId: string, tourId: string): Promise<boolean>;
  markSeen(userId: string, tourId: string): Promise<void>;
  getAll(userId: string): Promise<Set<string>>;
}

function storageKey(userId: string, tourId: string): string {
  return `tour.seen.${userId}.${tourId}`;
}

export const localSeenStore: SeenStore = {
  async hasSeen(userId, tourId) {
    return localStorage.getItem(storageKey(userId, tourId)) === '1';
  },
  async markSeen(userId, tourId) {
    localStorage.setItem(storageKey(userId, tourId), '1');
  },
  async getAll(userId) {
    const prefix = `tour.seen.${userId}.`;
    const seen = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) seen.add(k.slice(prefix.length));
    }
    return seen;
  },
};

export interface BackendSeenStoreOpts<TProfile = unknown> {
  /**
   * URL to fetch the user profile (or any object containing the seen-tours list).
   * e.g. (userId) => `/api/users/${userId}`
   */
  getUrl: (userId: string) => string;

  /**
   * Extract the seen-tour IDs from whatever the getUrl endpoint returns.
   * Defaults to treating the response as a bare string[].
   *
   * Example for a user-profile response:
   *   extractSeenTours: (profile) => profile.preferences?.seenTours ?? []
   */
  extractSeenTours?: (data: TProfile) => string[];

  /**
   * URL to PATCH / POST when marking a tour seen.
   * e.g. `/api/users/me/preferences`
   */
  updateUrl: (userId: string) => string;

  /**
   * HTTP method for the update request. Defaults to 'PATCH'.
   */
  updateMethod?: 'PATCH' | 'POST' | 'PUT';

  /**
   * Build the request body for the update call.
   * Receives the full updated seen-tours set so you can embed it however
   * your endpoint expects.
   *
   * Defaults to: (seenTours) => ({ seenTours: Array.from(seenTours) })
   *
   * Example for a nested preferences object:
   *   buildBody: (seenTours) => ({ preferences: { seenTours: Array.from(seenTours) } })
   */
  buildBody?: (seenTours: Set<string>) => unknown;

  headers?: Record<string, string>;
}

export function createBackendSeenStore<TProfile = unknown>(
  opts: BackendSeenStoreOpts<TProfile>,
): SeenStore {
  const {
    getUrl,
    extractSeenTours = (data) => data as unknown as string[],
    updateUrl,
    updateMethod = 'PATCH',
    buildBody = (seen) => ({ seenTours: Array.from(seen) }),
    headers = {},
  } = opts;

  const cache = new Map<string, Set<string>>();
  const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

  return {
    async hasSeen(userId, tourId) {
      const all = await this.getAll(userId);
      return all.has(tourId);
    },

    async markSeen(userId, tourId) {
      const all = await this.getAll(userId);
      if (all.has(tourId)) return; // already marked, skip the request
      all.add(tourId);
      cache.set(userId, all);

      await fetch(updateUrl(userId), {
        method: updateMethod,
        headers: jsonHeaders,
        body: JSON.stringify(buildBody(all)),
      });
    },

    async getAll(userId) {
      if (!cache.has(userId)) {
        const res = await fetch(getUrl(userId), { headers });
        if (!res.ok) {
          cache.set(userId, new Set());
          return cache.get(userId)!;
        }
        const data = (await res.json()) as TProfile;
        cache.set(userId, new Set(extractSeenTours(data)));
      }
      return cache.get(userId)!;
    },
  };
}
