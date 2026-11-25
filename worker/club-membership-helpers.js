import { mintSessionToken } from './session-token.js';
import { handleClub } from './club.js';
import { makeClubPlacesNamespace } from './club-places-fake.js';

/**
 * Test-only helpers for the #167 club membership tests (worker/club-*.test.js).
 * Not matched by vitest's `**\/*.test.js` include, and never imported by
 * worker/index.js, so none of this reaches the deployed bundle.
 */

export const SIGNING_KEY = 'test-session-signing-key';

/**
 * A Map-backed KV that keeps per-key metadata (the History list reads it) and
 * records every key it was asked to read, write, delete or list, so a test can
 * say what the Worker must never touch.
 */
export function makeKv(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([k, v]) => [k, { value: typeof v === 'string' ? v : JSON.stringify(v), metadata: null }])
  );
  const touched = [];
  const typeOf = (type) => (type && typeof type === 'object' ? type.type : type);
  return {
    store,
    touched,
    gets: [],
    puts: [],
    async get(key, type) {
      touched.push(key);
      this.gets.push(key);
      const entry = store.get(key);
      if (entry === undefined) return null;
      return typeOf(type) === 'json' ? JSON.parse(entry.value) : entry.value;
    },
    async getWithMetadata(key, type) {
      touched.push(key);
      const entry = store.get(key);
      if (entry === undefined) return { value: null, metadata: null };
      return { value: typeOf(type) === 'json' ? JSON.parse(entry.value) : entry.value, metadata: entry.metadata };
    },
    async put(key, value, options) {
      touched.push(key);
      this.puts.push(key);
      store.set(key, { value: typeof value === 'string' ? value : String(value), metadata: options?.metadata ?? null });
    },
    async delete(key) {
      touched.push(key);
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      touched.push(`list:${prefix}`);
      return {
        keys: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, entry]) => ({ name, ...(entry.metadata ? { metadata: entry.metadata } : {}) })),
        list_complete: true,
      };
    },
    /** The stored value parsed as JSON, or null. */
    json(key) {
      const entry = store.get(key);
      return entry === undefined ? null : JSON.parse(entry.value);
    },
  };
}

/** A Worker env with KV, the release flags on, enforcement on and the places namespace. */
export function makeEnv(over = {}, { placesFail = false } = {}) {
  const env = {
    PROFILES: makeKv(),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    ENTITLEMENT_ENFORCE: '1',
    FLAGS_FORCE: '1',
    WEB_ORIGIN: 'https://www.timer.simple-tech.app',
    ...over,
  };
  env.CLUB_PLACES = makeClubPlacesNamespace(() => env, { fail: placesFail });
  return env;
}

/** The Zoom app's credential: a Bearer session token, and nothing else. */
export const bearer = (uid) => ({ authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` });

export const memberKey = (clubId, uid) => `club-member:${clubId}:zoom:${uid}`;
export const clubOfKey = (uid) => `club-of:zoom:${uid}`;

/** Send a request through the club dispatcher, the way worker/index.js does. */
export function callClub(env, path, { method = 'GET', headers = {}, body } = {}) {
  const request = new Request(`https://zoom.timer.simple-tech.app${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleClub(request, new URL(request.url), env, { ctx: { waitUntil: () => {} } });
}

export const activate = (env, code, uid, extraHeaders = {}) =>
  callClub(env, '/api/club/activate', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '1.2.3.4', ...(uid ? bearer(uid) : {}), ...extraHeaders },
    body: { code },
  });

export const clubState = (env, uid) => callClub(env, '/api/club', { headers: uid ? bearer(uid) : {} });

export const leave = (env, uid) =>
  callClub(env, '/api/club/leave', { method: 'POST', headers: uid ? bearer(uid) : {} });

/** A live member row written by hand, the way a join would leave it. */
export async function seedMember(env, clubId, uid, role = 'member', { index = true } = {}) {
  const kv = env.PROFILES;
  await kv.put(memberKey(clubId, uid), JSON.stringify({ role, displayName: null, addedAt: 1 }));
  if (index) await kv.put(clubOfKey(uid), JSON.stringify({ clubId, at: 1 }));
}
