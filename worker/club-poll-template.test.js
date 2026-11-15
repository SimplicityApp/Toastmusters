import { describe, it, expect, beforeEach } from 'vitest';
import { handleClub, handleClubActivate, handleClubState } from './club.js';
import { createClubFromPending, clubMemberKey } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { verifyClubToken } from './club-token.js';
import { clubKey } from './entitlements.js';

/**
 * The club's poll template (#80, AC-10): the ballot setup an admin or editor
 * publishes once and every club device receives on its next refresh, the
 * same way presets and card sets travel.
 *
 * Contract: `PUT /api/club/poll-template` with a session and a club token,
 * body `{categories: [{role, label?, slots}], options: {postToChat,
 * showOnStage, expiryHours}}`, answers `{ver, pollTemplate}` and bumps the
 * club's `ver`; `GET /api/club` carries `pollTemplate` (null until published).
 */

const SIGNING_KEY = 'test-session-signing-key';

const TEMPLATE = {
  categories: [
    { role: 'Table Topics Speech', label: 'Best Table Topics Speaker', slots: 3 },
    { role: 'Standard Speech', slots: 3 },
    { role: 'Contest Speech', label: 'Best Contestant', slots: 2 },
  ],
  options: { postToChat: true, showOnStage: false, expiryHours: 12 },
};

function makeKv() {
  const store = new Map();
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return (type?.type ?? type) === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeBucket() {
  const store = new Map();
  return {
    store,
    head: async (key) => (store.has(key) ? { size: 1 } : null),
    get: async (key) => (store.has(key) ? { body: store.get(key), httpMetadata: {} } : null),
    put: async (key, bytes) => { store.set(key, bytes); },
    delete: async (key) => { store.delete(key); },
    list: async () => ({ objects: [], truncated: false }),
  };
}

let kv;
let env;
let seeded;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, CARD_ASSETS: makeBucket(), SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1', FLAGS_FORCE: '1' };
  seeded = null;
});

/** Activate one device on the test's club, as `uid` with `role`. */
async function activated({ uid, role } = {}) {
  seeded ??= await createClubFromPending(env, { clubName: 'Downtown Speakers', uid: 'buyer-uid' }, { code: 'DTSP7K2QM9' });
  const { clubId } = seeded;
  if (uid && role) {
    await kv.put(clubMemberKey(clubId, uid), JSON.stringify({ role, displayName: null, addedAt: 1, revokedAt: null }));
  }
  const res = await handleClubActivate(
    new Request('https://x/api/club/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
      },
      body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
    }),
    env
  );
  const body = await res.json();
  return { clubId, ...body, claims: verifyClubToken(body.clubToken, SIGNING_KEY) };
}

const headers = (clubToken, uid) => ({
  ...(clubToken ? { 'x-club': clubToken } : {}),
  ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
});

function publish(clubToken, uid, body = TEMPLATE) {
  const url = new URL('https://www.timer-dev.simple-tech.app/api/club/poll-template');
  return handleClub(
    new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers(clubToken, uid) }, body: JSON.stringify(body) }),
    url,
    env
  );
}

const clubState = async (clubToken) =>
  (await handleClubState(new Request('https://x/api/club', { headers: { 'x-club': clubToken } }), env)).json();

const readJson = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------

describe('PUT /api/club/poll-template', () => {
  it('lets an editor publish, bumps ver, and every club device sees it on its next refresh', async () => {
    const editor = await activated({ uid: 'editor-uid', role: 'editor' });
    const member = await activated();
    expect((await clubState(member.clubToken)).pollTemplate ?? null).toBeNull();
    const before = (await clubState(member.clubToken)).ver;

    const res = await publish(editor.clubToken, 'editor-uid');
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body?.ver).toBe(before + 1);
    const state = await clubState(member.clubToken);
    expect(state.ver).toBe(before + 1);
    expect(state.pollTemplate).toMatchObject({
      categories: [
        { role: 'Table Topics Speech', label: 'Best Table Topics Speaker', slots: 3 },
        { role: 'Standard Speech', slots: 3 },
        { role: 'Contest Speech', label: 'Best Contestant', slots: 2 },
      ],
      options: { postToChat: true, showOnStage: false, expiryHours: 12 },
    });
  });

  it('lets an admin publish too', async () => {
    const admin = await activated({ uid: 'admin-uid', role: 'admin' });
    expect((await publish(admin.clubToken, 'admin-uid')).status).toBe(200);
  });

  // Publishing changes every timer's ballot: not for whoever holds the code.
  it('refuses a member with 403, and a request missing either credential with 401', async () => {
    const member = await activated({ uid: 'member-uid', role: 'member' });
    expect((await publish(member.clubToken, 'member-uid')).status).toBe(403);
    expect((await publish(member.clubToken, null)).status).toBe(401);
    expect((await publish(null, 'member-uid')).status).toBe(401);
    expect((await clubState(member.clubToken)).pollTemplate ?? null).toBeNull();
  });

  it('refuses a template with no categories', async () => {
    const editor = await activated({ uid: 'editor-uid', role: 'editor' });
    expect((await publish(editor.clubToken, 'editor-uid', { categories: [], options: {} })).status).toBe(400);
  });

  it('refuses a lapsed club with the upgrade answer, and keeps what was already published', async () => {
    const editor = await activated({ uid: 'editor-uid', role: 'editor' });
    expect((await publish(editor.clubToken, 'editor-uid')).status).toBe(200);

    const club = JSON.parse(kv.store.get(clubKey(editor.clubId)));
    await kv.put(clubKey(editor.clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - 1000 }));

    expect((await publish(editor.clubToken, 'editor-uid', { ...TEMPLATE, options: { ...TEMPLATE.options, expiryHours: 2 } })).status).toBe(402);
    // Stored but unused: the device decides from `entitled`, as it does for presets.
    const state = await clubState(editor.clubToken);
    expect(state.entitled).toBe(false);
    expect(state.pollTemplate?.options?.expiryHours).toBe(12);
  });
});
