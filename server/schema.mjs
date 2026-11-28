/**
 * The database shape, shared by the Node server (server/store.mjs, JSON file)
 * and the hosted build (worker/store.mjs, Cloudflare D1 + R2).
 */
export function emptyDatabase() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    admin: null,
    settings: { confirm: 'true', notify: '', open: 'true', featured: [] },
    builds: [],
    commissions: [],
    feedback: [],
    referrals: [],
    profiles: [],
    sessions: []
  };
}
