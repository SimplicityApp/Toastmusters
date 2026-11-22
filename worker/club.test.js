import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from './index.js';
import { handleClubActivate, handleClubLeave, handleClubState } from './club.js';
import {
  createClubFromPending,
  rotateClubCode,
  normalizeCode,
  formatCode,
  clubPrefix,
  mintCode,
  clubOfKey,
} from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { clubKey } from './entitlements.js';
import { makeClubPlacesNamespace } from './club-places-fake.js';

/**
 * Activation end to end: a code puts a signed-in account in a club, every
 * rejection looks the same, and the club then follows the account through its
 * session. The membership rules themselves (places, one club, owner, block)
 * are in club-membership.test.js.
 */

const SIGNING_KEY = 'test-session-signing-key';
const DAY = 24 * 60 * 60 * 1000;

function makeKv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    store,
    get: async (key, type) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

/** A limiter that refuses after `limit` calls, the way the real binding does. */
function makeLimiter(limit = 10) {
  const seen = new Map();
  return {
    calls: seen,
    limit: async ({ key }) => {
      const next = (seen.get(key) ?? 0) + 1;
      seen.set(key, next);
      return { success: next <= limit };
    },
  };
}

let kv;
let env;

beforeEach(() => {
  kv = makeKv();
  env = { PROFILES: kv, SESSION_SIGNING_KEY: SIGNING_KEY, ENTITLEMENT_ENFORCE: '1' };
  env.CLUB_PLACES = makeClubPlacesNamespace(() => env);
});

const bearer = (uid) => (uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {});

const activateReq = (code, { uid = 'timer-uid', ip = '1.2.3.4' } = {}) =>
  new Request('https://x/api/club/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...bearer(uid) },
    body: JSON.stringify({ code }),
  });

const leaveReq = (uid) => new Request('https://x/api/club/leave', { method: 'POST', headers: bearer(uid) });

const stateReq = (uid) => new Request('https://x/api/club', { headers: bearer(uid) });

async function seedClub(over = {}) {
  return createClubFromPending(env, { clubName: 'Downtown Speakers', uid: 'buyer-uid', ...over }, { code: 'DTSP7K2QM9' });
}

// ---------------------------------------------------------------------------

describe('codes', () => {
  it('folds case, spaces, dashes and the letters Crockford leaves out', () => {
    expect(normalizeCode('dtsp-7k2qm9')).toBe('DTSP7K2QM9');
    expect(normalizeCode('  DTSP 7K2Q M9 ')).toBe('DTSP7K2QM9');
    // O reads as zero and I/L read as one on a phone screen.
    expect(normalizeCode('dtsp-7kOqIl')).toBe('DTSP7K0Q11');
    expect(normalizeCode(null)).toBe('');
    expect(normalizeCode('!!!')).toBe('');
  });

  it('shows a code with its dash back in', () => {
    expect(formatCode('dtsp7k2qm9')).toBe('DTSP-7K2QM9');
  });

  it('derives a four-character prefix from the club name', () => {
    expect(clubPrefix('Downtown Speakers')).toHaveLength(4);
    expect(clubPrefix('Downtown Speakers')).toMatch(/^[0-9A-Z]{4}$/);
    expect(clubPrefix('')).toBe('CLUB');
  });

  it('mints a six-character suffix out of the reduced alphabet', () => {
    const code = mintCode('Downtown Speakers');
    expect(code).toHaveLength(10);
    expect(code.slice(4)).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});

describe('POST /api/club/activate', () => {
  it('returns the club state, and no token', async () => {
    const { clubId } = await seedClub();

    const res = await handleClubActivate(activateReq('dtsp-7k2qm9', { uid: 'timer-uid' }), env);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      ver: 1,
      club: { id: clubId, name: 'Downtown Speakers' },
      plan: 'pro',
      entitled: true,
      source: 'club',
      role: 'member',
      isOwner: false,
      placesUsed: 1,
      // A club that has set no kit still gets one: the name is always there,
      // and the defaults are what a device renders until an admin chooses.
      kit: {
        name: 'Downtown Speakers',
        logoHash: null,
        logoUrl: null,
        primaryColor: '#772432',
        showOnCards: true,
        showOnReports: true,
      },
      badge: { x: 0.8, y: 0.12, scale: 0.12 },
      presets: null,
    });
    expect(body).not.toHaveProperty('clubToken');
  });

  it('writes a member row and the account\'s index, and nothing per device', async () => {
    const { clubId } = await seedClub();

    await handleClubActivate(activateReq('DTSP-7K2QM9', { uid: 'timer-uid' }), env);

    expect(await kv.get(`club-member:${clubId}:zoom:timer-uid`, 'json')).toMatchObject({ role: 'member' });
    expect(await kv.get(clubOfKey('timer-uid'), 'json')).toMatchObject({ clubId });
    expect([...kv.store.keys()].filter((key) => key.startsWith('club-device:'))).toEqual([]);
  });

  it('needs a Zoom account', async () => {
    await seedClub();
    const res = await handleClubActivate(activateReq('DTSP-7K2QM9', { uid: null }), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  });

  // One uniform failure, so probing cannot confirm that a club exists.
  it('answers unknown, lapsed and unparseable codes identically', async () => {
    const { clubId } = await seedClub();

    const unknown = await handleClubActivate(activateReq('ZZZZ-999999'), env);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'invalid_code' });

    // Lapsed: the code is real, the club stopped paying three weeks ago.
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));
    const lapsed = await handleClubActivate(activateReq('DTSP-7K2QM9'), env);
    expect(lapsed.status).toBe(400);
    expect(await lapsed.json()).toEqual({ error: 'invalid_code' });

    const junk = await handleClubActivate(activateReq('!!!'), env);
    expect(junk.status).toBe(400);
    expect(await junk.json()).toEqual({ error: 'invalid_code' });
  });

  // A dangling club-by-code entry must not become a 500 or a half-activation.
  it('fails the same way when the code points at a club record that is gone', async () => {
    await seedClub();
    await kv.delete(clubKey(await kv.get('club-by-code:DTSP7K2QM9')));

    const res = await handleClubActivate(activateReq('DTSP-7K2QM9'), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_code' });
  });

  it('refuses the eleventh attempt from one address', async () => {
    await seedClub();
    env.CLUB_ACTIVATE_LIMITER = makeLimiter(10);

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await handleClubActivate(activateReq('ZZZZ-999999'), env)).status).toBe(400);
    }
    const refused = await handleClubActivate(activateReq('DTSP-7K2QM9'), env);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'too_many_attempts' });

    // A different address is unaffected.
    expect((await handleClubActivate(activateReq('DTSP-7K2QM9', { ip: '9.9.9.9' }), env)).status).toBe(200);
  });

  it('keeps working when the limiter itself is down', async () => {
    await seedClub();
    env.CLUB_ACTIVATE_LIMITER = { limit: vi.fn(async () => { throw new Error('limiter down'); }) };

    expect((await handleClubActivate(activateReq('DTSP-7K2QM9'), env)).status).toBe(200);
  });

  it('refuses anything but POST, and says so when there is no signing key', async () => {
    expect((await handleClubActivate(new Request('https://x/api/club/activate'), env)).status).toBe(405);
    expect((await handleClubActivate(activateReq('DTSP-7K2QM9'), { ...env, SESSION_SIGNING_KEY: '' })).status).toBe(503);
  });
});

describe('GET /api/club', () => {
  async function activated(uid = 'timer-uid') {
    const seeded = await seedClub();
    await handleClubActivate(activateReq('DTSP-7K2QM9', { uid }), env);
    return seeded;
  }

  it('reports the club and the plan again, from the session alone', async () => {
    const { clubId } = await activated();

    const res = await handleClubState(stateReq('timer-uid'), env);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({ ver: 1, club: { id: clubId, name: 'Downtown Speakers' }, entitled: true, role: 'member' });
    expect(body).not.toHaveProperty('clubToken');
  });

  // A lapse can only land on a successful refresh at app start, never mid-meeting.
  it('reports a lapsed club as free without deleting anything', async () => {
    const { clubId } = await activated();
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));

    const body = await (await handleClubState(stateReq('timer-uid'), env)).json();
    expect(body).toMatchObject({ plan: 'free', entitled: false, club: { id: clubId } });
    expect(await kv.get(clubKey(clubId), 'json')).toBeTruthy();
  });

  // The buyer who is also in their own club must not be told they are free.
  it('combines the club with the caller\'s own subscription', async () => {
    const { clubId } = await activated();
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));
    await kv.put('entitlement:zoom:buyer-uid', JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + DAY }));

    const body = await (await handleClubState(stateReq('buyer-uid'), env)).json();
    expect(body).toMatchObject({ plan: 'pro', entitled: true, source: 'subscription' });
  });

  it('needs a session, and answers no_club for an account in none', async () => {
    await activated();

    expect((await handleClubState(stateReq(null), env)).status).toBe(401);
    const res = await handleClubState(stateReq('stranger'), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_club' });
  });

  it('answers no_club when the club record is gone', async () => {
    const { clubId } = await activated();
    await kv.delete(clubKey(clubId));

    expect((await handleClubState(stateReq('timer-uid'), env)).status).toBe(404);
  });

  it('refuses anything but GET', async () => {
    await activated();
    const res = await handleClubState(new Request('https://x/api/club', { method: 'POST', headers: bearer('timer-uid') }), env);
    expect(res.status).toBe(405);
  });
});

describe('POST /api/club/leave', () => {
  it('takes the account out of the club everywhere, and it can rejoin', async () => {
    const { clubId } = await seedClub();
    await handleClubActivate(activateReq('DTSP-7K2QM9'), env);

    const res = await handleClubLeave(leaveReq('timer-uid'), env);
    expect(res.status).toBe(200);
    expect(await kv.get(`club-member:${clubId}:zoom:timer-uid`, 'json')).toBeNull();
    expect((await handleClubState(stateReq('timer-uid'), env)).status).toBe(404);

    expect((await handleClubActivate(activateReq('DTSP-7K2QM9'), env)).status).toBe(200);
  });

  it('is quiet for an account in no club', async () => {
    await seedClub();
    const res = await handleClubLeave(leaveReq('stranger'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: true });
  });

  it('refuses a request with no session, and anything but POST', async () => {
    expect((await handleClubLeave(new Request('https://x/api/club/leave', { method: 'POST' }), env)).status).toBe(401);
    expect((await handleClubLeave(new Request('https://x/api/club/leave'), env)).status).toBe(405);
  });
});

describe('createClubFromPending', () => {
  it('mints the record, both lookups and the buyer as owner and first admin', async () => {
    const { clubId, code, club } = await createClubFromPending(
      env,
      { clubName: 'Downtown Speakers', uid: 'buyer-uid', email: 'treasurer@example.com', stripeCustomerId: 'cus_1' },
      { now: 1_000 }
    );

    expect(club).toMatchObject({ name: 'Downtown Speakers', ver: 1, status: 'active', billingEmail: 'treasurer@example.com', ownerUid: 'buyer-uid' });
    expect(await kv.get(`club-by-code:${code}`)).toBe(clubId);
    expect(await kv.get('club-by-customer:cus_1')).toBe(clubId);
    expect(await kv.get(`club-member:${clubId}:zoom:buyer-uid`, 'json')).toMatchObject({ role: 'admin' });
    expect(await kv.get(clubOfKey('buyer-uid'), 'json')).toEqual({ clubId, at: 1_000 });
  });

  it('names a club whose buyer skipped the field', async () => {
    const { club, code } = await createClubFromPending(env, { uid: 'buyer-uid' });
    expect(club.name).toBe(`Club ${code.slice(-4)}`);
  });
});

describe('rotateClubCode', () => {
  // Rotation is the lever a leaked code needs: it closes the door, and the
  // people already inside stay, by account.
  it('issues a new code and deletes the old one, keeping every member', async () => {
    const { clubId } = await seedClub();
    await handleClubActivate(activateReq('DTSP-7K2QM9'), env);

    const { code, club } = await rotateClubCode(env, clubId, { code: 'DTSPAAAAAA' });

    expect(code).toBe('DTSPAAAAAA');
    expect(club.ver).toBe(2);
    expect(await kv.get('club-by-code:DTSP7K2QM9')).toBeNull();
    expect(await kv.get('club-by-code:DTSPAAAAAA')).toBe(clubId);
    expect((await handleClubState(stateReq('timer-uid'), env)).status).toBe(200);
  });
});

describe('routing', () => {
  const ctx = { waitUntil: () => {} };

  it('dispatches /api/club and /api/club/activate ahead of the apex redirect', async () => {
    await seedClub();

    // Activation is a door behind the pro flag (worker/flags.test.js covers
    // both positions); this is only about where the request is routed.
    const activate = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/club/activate', {
        method: 'POST',
        headers: { host: 'timer.simple-tech.app', 'content-type': 'application/json', ...bearer('timer-uid') },
        body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
      }),
      { ...env, FLAGS_FORCE: '1' },
      ctx
    );
    expect(activate.status).toBe(200);

    const state = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/club', { headers: { host: 'timer.simple-tech.app' } }),
      env,
      ctx
    );
    expect(state.status).toBe(401);
  });

  it('404s an unknown club sub-route rather than falling through to the SPA', async () => {
    const res = await worker.fetch(
      new Request('https://www.timer.simple-tech.app/api/club/nope', { headers: { host: 'www.timer.simple-tech.app' } }),
      env,
      ctx
    );
    expect(res.status).toBe(404);
  });
});
