import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from './index.js';
import { handleClubActivate, handleClubLeave, handleClubState, verifiedClubId, deviceLabel } from './club.js';
import { createClubFromPending, rotateClubCode, normalizeCode, formatCode, clubPrefix, mintCode } from './club-admin.js';
import { mintSessionToken } from './session-token.js';
import { verifyClubToken } from './club-token.js';
import { clubKey } from './entitlements.js';

/**
 * Activation end to end: a code becomes a credential, every rejection looks the
 * same, and the device record is the handle revocation hangs off.
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
});

const activateReq = (code, { uid, ip = '1.2.3.4', ua, deviceId } = {}) =>
  new Request('https://x/api/club/activate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
      ...(ua ? { 'user-agent': ua } : {}),
      ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
    },
    body: JSON.stringify({ code, ...(deviceId ? { deviceId } : {}) }),
  });

const leaveReq = (clubToken) =>
  new Request('https://x/api/club/leave', { method: 'POST', headers: { 'x-club': clubToken } });

const stateReq = (clubToken, { uid } = {}) =>
  new Request('https://x/api/club', {
    headers: {
      ...(clubToken ? { 'x-club': clubToken } : {}),
      ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
    },
  });

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
  it('returns a club token and the club state', async () => {
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

    const claims = verifyClubToken(body.clubToken, SIGNING_KEY);
    expect(claims).toMatchObject({ clubId, uid: 'timer-uid', ver: 1 });
    expect(claims.deviceId).toBeTruthy();
  });

  it('writes a device record naming the browser, and a member record for the uid', async () => {
    const { clubId } = await seedClub();

    const res = await handleClubActivate(
      activateReq('DTSP-7K2QM9', { uid: 'timer-uid', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' }),
      env
    );
    const { clubToken } = await res.json();
    const { deviceId } = verifyClubToken(clubToken, SIGNING_KEY);

    expect(await kv.get(`club-device:${clubId}:${deviceId}`, 'json')).toMatchObject({
      label: 'Chrome · Windows',
      uid: 'timer-uid',
      revokedAt: null,
    });
    expect(await kv.get(`club-member:${clubId}:zoom:timer-uid`, 'json')).toMatchObject({ role: 'member' });
  });

  // The case the whole feature is sold on: whoever is timing on a borrowed
  // laptop at 6:55pm has no Zoom identity and still needs the club.
  it('activates a guest, writing a device record with uid null and no member record', async () => {
    const { clubId } = await seedClub();

    const res = await handleClubActivate(activateReq('DTSP-7K2QM9'), env);
    expect(res.status).toBe(200);
    const { clubToken } = await res.json();
    const { deviceId, uid } = verifyClubToken(clubToken, SIGNING_KEY);

    expect(uid).toBeNull();
    expect(await kv.get(`club-device:${clubId}:${deviceId}`, 'json')).toMatchObject({ uid: null });
    // Roles live only on member records, which is what makes "you cannot grant
    // editing rights to an anonymous device" true by construction. The buyer's
    // admin record, written when the club was minted, is the only one there.
    expect([...kv.store.keys()].filter((key) => key.startsWith(`club-member:${clubId}:`))).toEqual([
      `club-member:${clubId}:zoom:buyer-uid`,
    ]);
  });

  // A roster that grew a row every time somebody re-typed the code was showing
  // "4 devices · 1 person" for one person with two browsers, and an admin
  // cannot revoke a laptop they cannot pick out of a list of ghosts.
  it('reuses the browser’s own device row rather than minting a second', async () => {
    const { clubId } = await seedClub();
    const browser = 'b7f3c1d9e2a44f10b8c6d5e4f3a21098';

    const first = await handleClubActivate(activateReq('DTSP-7K2QM9', { uid: 'timer-uid', deviceId: browser }), env);
    const second = await handleClubActivate(activateReq('DTSP-7K2QM9', { uid: 'timer-uid', deviceId: browser }), env);

    expect(verifyClubToken((await first.json()).clubToken, SIGNING_KEY).deviceId).toBe(browser);
    expect(verifyClubToken((await second.json()).clubToken, SIGNING_KEY).deviceId).toBe(browser);
    expect([...kv.store.keys()].filter((key) => key.startsWith(`club-device:${clubId}:`))).toEqual([
      `club-device:${clubId}:${browser}`,
    ]);
  });

  // Re-typing the code is not an appeal.
  it('leaves a revoked row revoked when its browser activates again', async () => {
    const { clubId } = await seedClub();
    const browser = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    await handleClubActivate(activateReq('DTSP-7K2QM9', { deviceId: browser }), env);
    const key = `club-device:${clubId}:${browser}`;
    await kv.put(key, JSON.stringify({ ...(await kv.get(key, 'json')), revokedAt: 1 }));

    await handleClubActivate(activateReq('DTSP-7K2QM9', { deviceId: browser }), env);

    expect(await kv.get(key, 'json')).toMatchObject({ revokedAt: 1 });
  });

  it('mints an id for a browser that cannot keep one', async () => {
    const { clubId } = await seedClub();

    await handleClubActivate(activateReq('DTSP-7K2QM9', { deviceId: 'nope' }), env);

    const keys = [...kv.store.keys()].filter((key) => key.startsWith(`club-device:${clubId}:`));
    expect(keys).toHaveLength(1);
    expect(keys[0].endsWith(':nope')).toBe(false);
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
  async function activated(options) {
    const seeded = await seedClub();
    const res = await handleClubActivate(activateReq('DTSP-7K2QM9', options), env);
    const body = await res.json();
    return { ...seeded, ...body, claims: verifyClubToken(body.clubToken, SIGNING_KEY) };
  }

  it('re-mints the token and reports the plan again', async () => {
    const { clubId, clubToken } = await activated();

    const res = await handleClubState(stateReq(clubToken), env);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({ ver: 1, club: { id: clubId, name: 'Downtown Speakers' }, entitled: true });
    expect(verifyClubToken(body.clubToken, SIGNING_KEY)).toMatchObject({ clubId });
  });

  // A lapse can only land on a successful refresh at app start, never mid-meeting.
  it('reports a lapsed club as free without deleting anything', async () => {
    const { clubId, clubToken } = await activated();
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));

    const body = await (await handleClubState(stateReq(clubToken), env)).json();
    expect(body).toMatchObject({ plan: 'free', entitled: false, club: { id: clubId } });
    expect(await kv.get(clubKey(clubId), 'json')).toBeTruthy();
  });

  // The buyer who also typed their own club's code must not be told they are free.
  it('combines the club with the caller\'s own subscription', async () => {
    const { clubId, clubToken } = await activated();
    const club = await kv.get(clubKey(clubId), 'json');
    await kv.put(clubKey(clubId), JSON.stringify({ ...club, status: 'canceled', currentPeriodEnd: Date.now() - DAY }));
    await kv.put('entitlement:zoom:buyer-uid', JSON.stringify({ status: 'active', currentPeriodEnd: Date.now() + DAY }));

    const body = await (await handleClubState(stateReq(clubToken, { uid: 'buyer-uid' }), env)).json();
    expect(body).toMatchObject({ plan: 'pro', entitled: true, source: 'subscription' });
  });

  it('refuses a missing, forged or revoked credential', async () => {
    const { clubId, clubToken, claims } = await activated();

    expect((await handleClubState(stateReq(null), env)).status).toBe(401);
    expect((await handleClubState(stateReq('not.a.token'), env)).status).toBe(401);

    const device = await kv.get(`club-device:${clubId}:${claims.deviceId}`, 'json');
    await kv.put(`club-device:${clubId}:${claims.deviceId}`, JSON.stringify({ ...device, revokedAt: Date.now() }));
    const res = await handleClubState(stateReq(clubToken), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'club_access_revoked' });
  });

  it('404s when the club record is gone', async () => {
    const { clubId, clubToken } = await activated();
    await kv.delete(clubKey(clubId));

    expect((await handleClubState(stateReq(clubToken), env)).status).toBe(404);
  });

  it('refreshes lastSeenAt, but not on every call', async () => {
    const { clubId, clubToken, claims } = await activated();
    const deviceKey = `club-device:${clubId}:${claims.deviceId}`;

    const firstSeen = (await kv.get(deviceKey, 'json')).lastSeenAt;
    await handleClubState(stateReq(clubToken), env);
    expect((await kv.get(deviceKey, 'json')).lastSeenAt).toBe(firstSeen);

    await kv.put(deviceKey, JSON.stringify({ ...(await kv.get(deviceKey, 'json')), lastSeenAt: Date.now() - 2 * DAY }));
    await handleClubState(stateReq(clubToken), env);
    expect((await kv.get(deviceKey, 'json')).lastSeenAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('refuses anything but GET', async () => {
    const { clubToken } = await activated();
    const res = await handleClubState(
      new Request('https://x/api/club', { method: 'POST', headers: { 'x-club': clubToken } }),
      env
    );
    expect(res.status).toBe(405);
  });
});

describe('POST /api/club/leave', () => {
  const browser = 'c0ffee00c0ffee00c0ffee00c0ffee00';

  it('takes this device off the roster, so leaving and rejoining is one row', async () => {
    const { clubId } = await seedClub();
    const key = `club-device:${clubId}:${browser}`;

    const joined = await handleClubActivate(activateReq('DTSP-7K2QM9', { deviceId: browser }), env);
    const { clubToken } = await joined.json();

    expect(await handleClubLeave(leaveReq(clubToken), env)).toMatchObject({ status: 200 });
    expect(await kv.get(key, 'json')).toBeNull();

    await handleClubActivate(activateReq('DTSP-7K2QM9', { deviceId: browser }), env);
    expect([...kv.store.keys()].filter((k) => k.startsWith(`club-device:${clubId}:`))).toEqual([key]);
  });

  // The device calls this on its way out of a 403 too, and deleting the row
  // there would make leaving a way to undo a revocation.
  it('keeps a revoked row exactly where it is', async () => {
    const { clubId } = await seedClub();
    const key = `club-device:${clubId}:${browser}`;

    const joined = await handleClubActivate(activateReq('DTSP-7K2QM9', { deviceId: browser }), env);
    const { clubToken } = await joined.json();
    await kv.put(key, JSON.stringify({ ...(await kv.get(key, 'json')), revokedAt: 1 }));

    await handleClubLeave(leaveReq(clubToken), env);

    expect(await kv.get(key, 'json')).toMatchObject({ revokedAt: 1 });
  });

  it('refuses a request with no club token, and anything but POST', async () => {
    expect((await handleClubLeave(new Request('https://x/api/club/leave', { method: 'POST' }), env)).status).toBe(401);
    expect((await handleClubLeave(new Request('https://x/api/club/leave'), env)).status).toBe(405);
  });
});

describe('verifiedClubId', () => {
  it('is the clubId only while the device record says so', async () => {
    const { clubId } = await seedClub();
    const body = await (await handleClubActivate(activateReq('DTSP-7K2QM9'), env)).json();
    const claims = verifyClubToken(body.clubToken, SIGNING_KEY);

    expect(await verifiedClubId(env, claims)).toBe(clubId);

    const key = `club-device:${clubId}:${claims.deviceId}`;
    await kv.put(key, JSON.stringify({ ...(await kv.get(key, 'json')), revokedAt: Date.now() }));
    expect(await verifiedClubId(env, claims)).toBeNull();

    await kv.delete(key);
    expect(await verifiedClubId(env, claims)).toBeNull();
    expect(await verifiedClubId(env, null)).toBeNull();
  });
});

describe('createClubFromPending', () => {
  it('mints the record, both lookups and the buyer as first admin', async () => {
    const { clubId, code, club } = await createClubFromPending(
      env,
      { clubName: 'Downtown Speakers', uid: 'buyer-uid', email: 'treasurer@example.com', stripeCustomerId: 'cus_1' },
      { now: 1_000 }
    );

    expect(club).toMatchObject({ name: 'Downtown Speakers', ver: 1, status: 'active', billingEmail: 'treasurer@example.com' });
    expect(await kv.get(`club-by-code:${code}`)).toBe(clubId);
    expect(await kv.get('club-by-customer:cus_1')).toBe(clubId);
    expect(await kv.get(`club-member:${clubId}:zoom:buyer-uid`, 'json')).toMatchObject({ role: 'admin' });
  });

  it('names a club whose buyer skipped the field', async () => {
    const { club, code } = await createClubFromPending(env, { uid: 'buyer-uid' });
    expect(club.name).toBe(`Club ${code.slice(-4)}`);
  });
});

describe('rotateClubCode', () => {
  // Rotation is the lever a leaked code needs, and it has to bite now rather
  // than whenever a cached token happens to expire.
  it('issues a new code, deletes the old one and revokes every device', async () => {
    const { clubId } = await seedClub();
    const body = await (await handleClubActivate(activateReq('DTSP-7K2QM9'), env)).json();
    const claims = verifyClubToken(body.clubToken, SIGNING_KEY);

    const { code, club } = await rotateClubCode(env, clubId, { code: 'DTSPAAAAAA' });

    expect(code).toBe('DTSPAAAAAA');
    expect(club.ver).toBe(2);
    expect(await kv.get('club-by-code:DTSP7K2QM9')).toBeNull();
    expect(await kv.get('club-by-code:DTSPAAAAAA')).toBe(clubId);
    expect(await verifiedClubId(env, claims)).toBeNull();
  });
});

describe('deviceLabel', () => {
  it('names the browser and the OS, and degrades to something printable', () => {
    const ua = (value) => new Request('https://x/', { headers: { 'user-agent': value } });

    expect(deviceLabel(ua('Mozilla/5.0 (Macintosh) Safari/605'))).toBe('Safari · macOS');
    expect(deviceLabel(ua('Mozilla/5.0 (Windows NT 10.0) Firefox/121'))).toBe('Firefox · Windows');
    expect(deviceLabel(ua('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120'))).toBe('Edge · Windows');
    expect(deviceLabel(new Request('https://x/'))).toBe('Unknown device');
  });
});

describe('routing', () => {
  const ctx = { waitUntil: () => {} };

  it('dispatches /api/club and /api/club/activate ahead of the apex redirect', async () => {
    await seedClub();

    const activate = await worker.fetch(
      new Request('https://timer.simple-tech.app/api/club/activate', {
        method: 'POST',
        headers: { host: 'timer.simple-tech.app', 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'DTSP-7K2QM9' }),
      }),
      env,
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
