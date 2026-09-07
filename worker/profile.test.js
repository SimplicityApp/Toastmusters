import { describe, it, expect, beforeEach } from 'vitest';
import { handleProfile } from './profile.js';
import { mintSessionToken } from './session-token.js';

const SIGNING_KEY = 'test-session-signing-key';

/** In-memory stand-in for the KV namespace, with the same get('json')/put shape. */
function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
  };
}

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, SESSION_SIGNING_KEY: SIGNING_KEY };
});

const tokenFor = (uid) => mintSessionToken(uid, SIGNING_KEY);

function req(method, { uid, body, token, headers = {} } = {}) {
  const bearer = token ?? (uid ? tokenFor(uid) : null);
  return new Request('https://zoom.timer.simple-tech.app/api/profile', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const entry = (value, updatedAt) => ({ value, updatedAt });

describe('handleProfile authentication', () => {
  // The security boundary: identity comes from a signed token, never from
  // anything the client says about itself.
  it('refuses a request with no token', async () => {
    expect((await handleProfile(req('GET'), env)).status).toBe(401);
    expect((await handleProfile(req('PUT', { body: { profile: {} } }), env)).status).toBe(401);
  });

  it('refuses a token signed with the wrong key', async () => {
    const foreign = mintSessionToken('someone', 'attacker-key');

    expect((await handleProfile(req('GET', { token: foreign }), env)).status).toBe(401);
  });

  it('refuses a garbage token', async () => {
    for (const bad of ['', 'nonsense', 'a.b']) {
      expect((await handleProfile(req('GET', { token: bad }), env)).status).toBe(401);
    }
  });

  // Two users must never see each other's settings.
  it('scopes storage to the uid inside the token', async () => {
    await handleProfile(
      req('PUT', { uid: 'user-a', body: { profile: { fields: { toastmaster_agenda: entry('a-agenda', 100) } } } }),
      env
    );

    const res = await handleProfile(req('GET', { uid: 'user-b' }), env);

    expect((await res.json()).profile.fields).toEqual({});
  });
});

describe('handleProfile reads and writes', () => {
  it('returns an empty profile for a user with nothing stored', async () => {
    const res = await handleProfile(req('GET', { uid: 'new-user' }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: { rev: 0, fields: {} } });
  });

  it('stores a profile and reads it back', async () => {
    await handleProfile(
      req('PUT', {
        uid: 'u1',
        body: { profile: { fields: { toastmaster_role_rules: entry({ speech: 5 }, 100) } } },
      }),
      env
    );

    const res = await handleProfile(req('GET', { uid: 'u1' }), env);

    expect((await res.json()).profile.fields.toastmaster_role_rules).toEqual(entry({ speech: 5 }, 100));
  });

  it('merges per field and returns the merged document', async () => {
    await handleProfile(
      req('PUT', {
        uid: 'u1',
        body: { profile: { fields: { toastmaster_agenda: entry('first', 500), toastmaster_prompts: entry('p', 100) } } },
      }),
      env
    );

    const res = await handleProfile(
      req('PUT', {
        uid: 'u1',
        body: { profile: { fields: { toastmaster_agenda: entry('stale', 200), toastmaster_overlay_mode: entry('card', 900) } } },
      }),
      env
    );
    const { profile } = await res.json();

    expect(profile.fields.toastmaster_agenda).toEqual(entry('first', 500));
    expect(profile.fields.toastmaster_prompts).toEqual(entry('p', 100));
    expect(profile.fields.toastmaster_overlay_mode).toEqual(entry('card', 900));
  });

  // KV rate-limits writes per key; a device that syncs on every load must not
  // burn that budget on no-op updates.
  it('does not write when nothing was newer', async () => {
    await handleProfile(
      req('PUT', { uid: 'u1', body: { profile: { fields: { toastmaster_agenda: entry('v', 500) } } } }),
      env
    );
    const writesAfterFirst = kv.store.get('profile:zoom:u1');

    const res = await handleProfile(
      req('PUT', { uid: 'u1', body: { profile: { fields: { toastmaster_agenda: entry('older', 100) } } } }),
      env
    );

    expect((await res.json()).changed).toBe(false);
    expect(kv.store.get('profile:zoom:u1')).toBe(writesAfterFirst);
  });

  it('ignores keys outside the synced set', async () => {
    const res = await handleProfile(
      req('PUT', { uid: 'u1', body: { profile: { fields: { evil_key: entry('x', 999) } } } }),
      env
    );

    expect((await res.json()).profile.fields).toEqual({});
  });
});

describe('handleProfile rejects bad input', () => {
  it('rejects invalid JSON', async () => {
    const request = new Request('https://x/api/profile', {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokenFor('u1')}`, 'content-type': 'application/json' },
      body: 'not json',
    });

    expect((await handleProfile(request, env)).status).toBe(400);
  });

  it('rejects an oversized body by its declared length, without reading it', async () => {
    const res = await handleProfile(
      req('PUT', { uid: 'u1', body: { profile: {} }, headers: { 'content-length': String(200 * 1024) } }),
      env
    );

    expect(res.status).toBe(413);
  });

  it('rejects an oversized body that lied about its length', async () => {
    const huge = 'x'.repeat(200 * 1024);
    const request = new Request('https://x/api/profile', {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokenFor('u1')}` },
      body: JSON.stringify({ profile: { fields: { toastmaster_agenda: entry(huge, 1) } } }),
    });

    expect((await handleProfile(request, env)).status).toBe(413);
  });

  it('rejects methods other than GET and PUT', async () => {
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      expect((await handleProfile(req(method, { uid: 'u1', body: {} }), env)).status).toBe(405);
    }
  });

  // Identity ships before storage, so an unattached binding is a real state.
  it('reports 503 when the KV binding is missing, rather than throwing', async () => {
    const res = await handleProfile(req('GET', { uid: 'u1' }), { SESSION_SIGNING_KEY: SIGNING_KEY });

    expect(res.status).toBe(503);
  });

  it('never lets a per-user answer reach a cache', async () => {
    const res = await handleProfile(req('GET', { uid: 'u1' }), env);

    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
