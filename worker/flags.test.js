import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  FLAG_FALLBACKS,
  FLAGS_TIMEOUT_MS,
  ANONYMOUS_DISTINCT_ID,
  flagCacheKey,
  flagOverride,
  resolveFlags,
  flagEnabled,
} from './flags.js';
import { handleBilling, customerByUidKey } from './billing.js';
import { handleAuthStart, handleOAuthCallback } from './auth.js';
import { handleClub } from './club.js';
import { createClubFromPending, clubByCodeKey } from './club-admin.js';
import { ADMIN_COOKIE, magicKey, mintAdminSession } from './club-magic.js';
import { entitlementKey } from './entitlements.js';
import { mintSessionToken } from './session-token.js';
import worker from './index.js';

/**
 * The release flags, end to end: the resolver's failure modes, the
 * per-environment override, the edge cache key, every gated endpoint in both
 * positions, and the two checks that keep the declared list honest.
 *
 * The emphatic part is the failure modes. A flag layer that fails *closed* when
 * PostHog blips would dark Pro for everyone, which is a worse outage than the
 * one flags exist to prevent — so each way PostHog can fail is its own case,
 * and each asserts FLAG_FALLBACKS rather than all-off.
 */

const ctx = { waitUntil: () => {} };
const env = { POSTHOG_API_KEY: 'phc_test' };
const allOn = Object.fromEntries(Object.keys(FLAG_FALLBACKS).map((key) => [key, true]));
const allOff = Object.fromEntries(Object.keys(FLAG_FALLBACKS).map((key) => [key, false]));

/** A /flags?v=2 answer, as PostHog shapes it. */
const flagsAnswer = (enabled) => ({
  flags: Object.fromEntries(
    Object.entries(enabled).map(([key, on]) => [key, { key, enabled: on, reason: { code: 'condition_match' } }])
  ),
  errorsWhileComputingFlags: false,
});

const respondWith = (body, status = 200) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

// Silences the fallback warning; the cases below are about what comes back.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('flagOverride', () => {
  it('reads FLAGS_FORCE as three-valued, with "ask PostHog" as the default', () => {
    expect(flagOverride({ FLAGS_FORCE: '1' })).toBe(true);
    expect(flagOverride({ FLAGS_FORCE: '0' })).toBe(false);
    for (const value of [undefined, '', 'true', 'yes', 1, 0]) {
      expect(flagOverride({ FLAGS_FORCE: value })).toBeNull();
    }
    expect(flagOverride(undefined)).toBeNull();
  });
});

describe('resolveFlags', () => {
  it('asks PostHog for this user, and returns what it says for declared keys', async () => {
    const fetchMock = respondWith(flagsAnswer(allOn));
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveFlags(env, { uid: 'abc' }, ctx)).toEqual(allOn);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/flags?v=2');
    expect(init.method).toBe('POST');
    // The same namespace both apps identify with, so one condition in the
    // dashboard targets a person on both surfaces.
    expect(JSON.parse(init.body)).toEqual({ api_key: 'phc_test', distinct_id: 'zoom:abc' });
  });

  it('asks as the shared anonymous id when there is no uid', async () => {
    const fetchMock = respondWith(flagsAnswer(allOn));
    vi.stubGlobal('fetch', fetchMock);

    await resolveFlags(env, {}, ctx);
    await resolveFlags(env, undefined, ctx);

    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body).distinct_id).toBe(ANONYMOUS_DISTINCT_ID);
    }
  });

  it('ignores flags the code does not declare, and keeps declared ones PostHog omits at their fallback', async () => {
    vi.stubGlobal('fetch', respondWith({ flags: { some_other_flag: { key: 'some_other_flag', enabled: true } } }));

    const flags = await resolveFlags(env, { uid: 'abc' }, ctx);
    expect(flags).toEqual({ ...FLAG_FALLBACKS });
    expect(flags).not.toHaveProperty('some_other_flag');
  });

  it('keeps a declared key at its fallback when PostHog sends a non-boolean for it', async () => {
    vi.stubGlobal('fetch', respondWith({ flags: { pro: { key: 'pro', enabled: 'yes' } } }));

    expect(await resolveFlags(env, { uid: 'abc' }, ctx)).toEqual({ ...FLAG_FALLBACKS });
  });

  describe('falls back to the checked-in values, never to all-off, when', () => {
    it('no PostHog key is configured (and asks nobody)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(await resolveFlags({}, { uid: 'abc' }, ctx)).toEqual(FLAG_FALLBACKS);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('PostHog answers 500', async () => {
      vi.stubGlobal('fetch', respondWith('nope', 500));
      expect(await resolveFlags(env, { uid: 'abc' }, ctx)).toEqual(FLAG_FALLBACKS);
    });

    it('PostHog does not answer in time', async () => {
      vi.useFakeTimers();
      // Honors the abort, the way a real fetch does.
      vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })));

      const pending = resolveFlags(env, { uid: 'abc' }, ctx);
      await vi.advanceTimersByTimeAsync(FLAGS_TIMEOUT_MS);
      expect(await pending).toEqual(FLAG_FALLBACKS);
    });

    it('PostHog stalls on the body even after the headers arrived', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })));

      const pending = resolveFlags(env, { uid: 'abc' }, ctx);
      await vi.advanceTimersByTimeAsync(FLAGS_TIMEOUT_MS);
      expect(await pending).toEqual(FLAG_FALLBACKS);
    });

    it('the body is malformed', async () => {
      for (const body of ['not json', {}, { flags: null }, { flags: [] }, { flags: 'pro' }, []]) {
        vi.stubGlobal('fetch', respondWith(body));
        expect(await resolveFlags(env, { uid: 'abc' }, ctx)).toEqual(FLAG_FALLBACKS);
      }
    });

    it('the network throws', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      expect(await resolveFlags(env, { uid: 'abc' }, ctx)).toEqual(FLAG_FALLBACKS);
    });

    // Over the free quota, PostHog answers 200 with the flags missing. Read
    // naively that is "everything off", which is exactly the outage to avoid.
    it('PostHog says the project is over its flag quota', async () => {
      vi.stubGlobal('fetch', respondWith({ ...flagsAnswer(allOff), quotaLimited: ['feature_flags'] }));
      expect(await resolveFlags(env, { uid: 'abc' }, ctx)).toEqual(FLAG_FALLBACKS);
    });
  });

  it('never rejects, even when fetch itself is missing', async () => {
    vi.stubGlobal('fetch', undefined);
    await expect(resolveFlags(env, { uid: 'abc' }, ctx)).resolves.toEqual(FLAG_FALLBACKS);
  });
});

describe('FLAGS_FORCE', () => {
  it('"1" turns every declared flag on without asking PostHog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveFlags({ ...env, FLAGS_FORCE: '1' }, { uid: 'abc' }, ctx)).toEqual(allOn);
    expect(await resolveFlags({ FLAGS_FORCE: '1' }, {}, ctx)).toEqual(allOn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"0" turns every declared flag off without asking PostHog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveFlags({ ...env, FLAGS_FORCE: '0' }, { uid: 'abc' }, ctx)).toEqual(allOff);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unset or empty asks PostHog', async () => {
    for (const FLAGS_FORCE of [undefined, '']) {
      const fetchMock = respondWith(flagsAnswer(allOn));
      vi.stubGlobal('fetch', fetchMock);

      expect(await resolveFlags({ ...env, FLAGS_FORCE }, { uid: 'abc' }, ctx)).toEqual(allOn);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the edge cache', () => {
  /** A Cache API stand-in keyed by URL, like caches.default. */
  function makeCache() {
    const store = new Map();
    return {
      store,
      match: vi.fn(async (request) => store.get(request.url)?.clone()),
      put: vi.fn(async (request, response) => { store.set(request.url, response); }),
    };
  }

  let cache;
  let waited;
  const waitingCtx = { waitUntil: (promise) => waited.push(promise) };

  beforeEach(() => {
    cache = makeCache();
    waited = [];
    vi.stubGlobal('caches', { default: cache });
  });

  it('caches a good answer under the caller\'s own key for 60 seconds', async () => {
    vi.stubGlobal('fetch', respondWith(flagsAnswer(allOn)));

    await resolveFlags(env, { uid: 'abc' }, waitingCtx);
    await Promise.all(waited);

    const key = flagCacheKey('zoom:abc');
    expect(cache.store.has(key)).toBe(true);
    expect(cache.store.get(key).headers.get('Cache-Control')).toBe('max-age=60');
  });

  it('serves a cached answer without asking PostHog again', async () => {
    const fetchMock = respondWith(flagsAnswer(allOn));
    vi.stubGlobal('fetch', fetchMock);

    await resolveFlags(env, { uid: 'abc' }, waitingCtx);
    await Promise.all(waited);
    expect(await resolveFlags(env, { uid: 'abc' }, waitingCtx)).toEqual(allOn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The failure this key shape exists to prevent: the anonymous answer served
  // to an identified user would silently defeat single-account targeting.
  it('keeps an identified user and the anonymous caller apart', async () => {
    expect(flagCacheKey('zoom:abc')).not.toBe(flagCacheKey(ANONYMOUS_DISTINCT_ID));

    // PostHog targets zoom:abc only.
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const { distinct_id: id } = JSON.parse(init.body);
      return new Response(JSON.stringify(flagsAnswer(id === 'zoom:abc' ? allOn : allOff)));
    }));

    expect(await resolveFlags(env, {}, waitingCtx)).toEqual(allOff);
    await Promise.all(waited);
    expect(await resolveFlags(env, { uid: 'abc' }, waitingCtx)).toEqual(allOn);
    await Promise.all(waited);
    expect(await resolveFlags(env, {}, waitingCtx)).toEqual(allOff);

    expect([...cache.store.keys()].sort()).toEqual(
      [flagCacheKey(ANONYMOUS_DISTINCT_ID), flagCacheKey('zoom:abc')].sort()
    );
  });

  it('does not cache a failure, so the next session retries', async () => {
    vi.stubGlobal('fetch', respondWith('nope', 500));

    expect(await resolveFlags(env, { uid: 'abc' }, waitingCtx)).toEqual(FLAG_FALLBACKS);
    await Promise.all(waited);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('treats a cache that throws as a miss, and still asks PostHog', async () => {
    cache.match.mockRejectedValue(new Error('cache down'));
    cache.put.mockRejectedValue(new Error('cache down'));
    vi.stubGlobal('fetch', respondWith(flagsAnswer(allOn)));

    expect(await resolveFlags(env, { uid: 'abc' }, waitingCtx)).toEqual(allOn);
    await Promise.all(waited);
  });

  it('re-applies fallbacks to a cached entry that predates a declared key', async () => {
    cache.store.set(flagCacheKey('zoom:abc'), new Response(JSON.stringify({})));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveFlags(env, { uid: 'abc' }, waitingCtx)).toEqual({ ...FLAG_FALLBACKS });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('flagEnabled', () => {
  it.each(Object.keys(FLAG_FALLBACKS))('answers %s as a boolean', async (key) => {
    expect(await flagEnabled({ FLAGS_FORCE: '1' }, key)).toBe(true);
    expect(await flagEnabled({ FLAGS_FORCE: '0' }, key)).toBe(false);
    expect(await flagEnabled({}, key)).toBe(FLAG_FALLBACKS[key]);
  });

  it('is false for a key nobody declared, even with every flag forced on', async () => {
    expect(await flagEnabled({ FLAGS_FORCE: '1' }, 'not_a_flag')).toBe(false);
  });
});

// ── Gated endpoints ─────────────────────────────────────────────────────────
//
// One table, each row asserted in both positions, mirroring gating.test.js.
// Off is a bare 404 that does no work; on behaves exactly as it did before the
// flag existed.

const SIGNING_KEY = 'test-session-signing-key';

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
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function fakeStripe() {
  return {
    findPriceByLookupKey: vi.fn(async () => 'price_m'),
    createCustomer: vi.fn(async () => ({ id: 'cus_new' })),
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })),
    retrieveCheckoutSession: vi.fn(async () => ({ id: 'cs_1', payment_status: 'paid', status: 'complete' })),
    createPortalSession: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/1' })),
  };
}

function billingEnv(over = {}) {
  return {
    PROFILES: makeKv({ [customerByUidKey('u1')]: 'cus_1' }),
    SESSION_SIGNING_KEY: SIGNING_KEY,
    STRIPE_SECRET_KEY: 'sk_test',
    WEB_ORIGIN: 'https://www.example.test',
    ...over,
  };
}

function callBilling(env, stripe, { path, method = 'POST', uid = 'u1', body, query = '' }) {
  const url = new URL(`https://zoom.example.test${path}${query}`);
  const request = new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleBilling(request, url, env, { stripe, ctx });
}

/**
 * One run of a billing route: the response, and whether Stripe was asked to do
 * anything.
 */
async function runBilling(env, { uid, ...call }, didWork) {
  const stripe = fakeStripe();
  const res = await callBilling(env, stripe, { ...call, uid });
  return { res, didWork: didWork(stripe).mock.calls.length > 0 };
}

const authEnv = (over = {}) => ({
  SESSION_SIGNING_KEY: SIGNING_KEY,
  ZOOM_CLIENT_ID: 'client-id',
  ZOOM_CLIENT_SECRET: 'client-secret',
  WEB_ORIGIN: 'https://www.example.test',
  ...over,
});

/** Who is calling a sign-in route: nobody usually, a session cookie otherwise. */
const sessionCookieFor = (uid) => (uid ? `tt_session=${mintSessionToken(uid, SIGNING_KEY)}` : null);
const nonceFrom = (res) => res.headers.get('set-cookie')?.match(/tt_oauth=([^;]+)/)?.[1] ?? null;

/** GET /api/auth/zoom/start. Its work is a redirect to Zoom carrying a nonce. */
async function runSignInStart(env, { uid }) {
  const url = new URL('https://www.example.test/api/auth/zoom/start?returnTo=%2Faccount');
  const cookie = sessionCookieFor(uid);
  const res = await handleAuthStart(new Request(url, { headers: cookie ? { cookie } : {} }), url, env, { ctx });
  const didWork = res.status === 302 && res.headers.get('location').startsWith('https://zoom.us/') && Boolean(nonceFrom(res));
  return { res, didWork };
}

/**
 * GET /oauth/redirect?state=… with a state this Worker really signed (minted
 * with sign-in on, so the only thing varying is the callback's own gate). Its
 * work is the code exchange with Zoom.
 */
async function runSignInCallback(env, { uid }) {
  const startUrl = new URL('https://www.example.test/api/auth/zoom/start?returnTo=%2Faccount');
  const started = await handleAuthStart(new Request(startUrl), startUrl, authEnv({ FLAGS_FORCE: '1' }), { ctx });
  const state = new URL(started.headers.get('location')).searchParams.get('state');

  const url = new URL(`https://www.example.test/oauth/redirect?code=the-code&state=${encodeURIComponent(state)}`);
  const cookie = [`tt_oauth=${nonceFrom(started)}`, sessionCookieFor(uid)].filter(Boolean).join('; ');
  const fetchImpl = vi.fn(async (target) =>
    String(target).startsWith('https://zoom.us/oauth/token')
      ? new Response(JSON.stringify({ access_token: 'at' }))
      : new Response(JSON.stringify({ id: 'zoom-user-1' }))
  );
  const res = await handleOAuthCallback(new Request(url, { headers: { cookie } }), url, env, { fetchImpl, ctx });
  return { res, didWork: fetchImpl.mock.calls.length > 0 };
}

const CLUB_CODE = 'DTSP7K2QM9';
const BILLING_EMAIL = 'treasurer@example.test';

/** The send_email binding, recording what it was handed. */
function makeEmail() {
  const sent = [];
  return { sent, send: async (message) => { sent.push(message); } };
}

const clubEnv = (over = {}) => ({
  PROFILES: makeKv(),
  EMAIL: makeEmail(),
  SESSION_SIGNING_KEY: SIGNING_KEY,
  ENTITLEMENT_ENFORCE: '1',
  WEB_ORIGIN: 'https://www.example.test',
  MAGIC_LINK_FROM: 'no-reply@example.test',
  ...over,
});

/** A club to be let into, seeded once per store whoever asks first. */
async function seedClubOnce(env) {
  const existing = await env.PROFILES.get(clubByCodeKey(CLUB_CODE));
  if (existing) return existing;
  const { clubId } = await createClubFromPending(
    env,
    { clubName: 'Downtown Speakers', uid: 'buyer-uid', email: BILLING_EMAIL },
    { code: CLUB_CODE }
  );
  return clubId;
}

/** A `prepare` for the routes that only need the club to exist. */
async function withClub(env) {
  await seedClubOnce(env);
}

/** A paying subscriber with a Stripe customer, the only caller create serves. */
async function seedSubscriber(env, uid) {
  if (!uid) return;
  await env.PROFILES.put(
    entitlementKey(uid),
    JSON.stringify({ plan: 'pro', status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false })
  );
  await env.PROFILES.put(customerByUidKey(uid), `cus_${uid}`);
}

/** A fresh, unspent admin link for the seeded club. */
async function seedMagicToken(env) {
  const clubId = await seedClubOnce(env);
  const token = `magic-${env.PROFILES.store.size}`;
  const now = Date.now();
  await env.PROFILES.put(
    magicKey(token),
    JSON.stringify({ clubId, email: BILLING_EMAIL, createdAt: now, exp: now + 60_000 })
  );
  return `?t=${token}`;
}

const kvSnapshot = (kv) => JSON.stringify([...kv.store.entries()].sort());

/**
 * One call through the /api/club dispatch, as a Zoom app would make it (a
 * bearer when there is a uid). Its work is any write to the store, or a mail.
 * `prepare` seeds what the route needs before the snapshot is taken, and may
 * hand back a query string.
 */
async function runClubDoor(env, { uid, path, body, prepare }) {
  const query = (await prepare?.(env, uid)) ?? '';
  const url = new URL(`https://www.example.test${path}${query}`);
  const headers = {
    'content-type': 'application/json',
    ...(uid ? { authorization: `Bearer ${mintSessionToken(uid, SIGNING_KEY)}` } : {}),
  };
  const before = kvSnapshot(env.PROFILES);
  const mailed = env.EMAIL.sent.length;
  const res = await handleClub(
    new Request(url, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    url,
    env,
    { ctx }
  );
  return { res, didWork: kvSnapshot(env.PROFILES) !== before || env.EMAIL.sent.length > mailed };
}

/**
 * `off` is what a dark route answers: a bare 404, or — for the callback, which
 * shares its URL with the Marketplace install — null, so index.js falls through
 * to the SPA's install-success page exactly as for a request with no state.
 *
 * `noSession` is what a route that needs a session answers a caller without
 * one while the flag is off. Billing checks the session first, so it stays 401;
 * the club doors are gated in the dispatch ahead of everything, so it is 404.
 */
const GATED = [
  {
    flag: 'pro',
    name: 'POST /api/billing/checkout',
    env: billingEnv,
    run: (env, caller) => runBilling(env, { path: '/api/billing/checkout', body: { interval: 'monthly' }, ...caller }, (s) => s.createCheckoutSession),
    onStatus: 200,
    off: 'not found',
    needsSession: true,
    noSession: 401,
  },
  {
    flag: 'pro',
    name: 'POST /api/billing/portal',
    env: billingEnv,
    run: (env, caller) => runBilling(env, { path: '/api/billing/portal', ...caller }, (s) => s.createPortalSession),
    onStatus: 200,
    off: 'not found',
    needsSession: true,
    noSession: 401,
  },
  {
    flag: 'pro',
    name: 'GET /api/auth/zoom/start',
    env: authEnv,
    run: runSignInStart,
    onStatus: 302,
    off: 'not found',
    needsSession: false,
  },
  {
    flag: 'pro',
    name: 'GET /oauth/redirect?state',
    env: authEnv,
    run: runSignInCallback,
    onStatus: 302,
    off: 'falls through',
    needsSession: false,
  },
  // Only the doors into a club. The refresh, presets, meetings and the admin
  // routes stay open, and are asserted to below.
  {
    flag: 'pro',
    name: 'POST /api/club/activate',
    env: clubEnv,
    run: (env, { uid }) => runClubDoor(env, { uid, path: '/api/club/activate', body: { code: 'DTSP-7K2QM9' }, prepare: withClub }),
    onStatus: 200,
    off: 'not found',
    needsSession: false,
  },
  {
    flag: 'pro',
    name: 'POST /api/club/create',
    env: clubEnv,
    run: (env, { uid }) => runClubDoor(env, { uid, path: '/api/club/create', body: { clubName: 'Downtown Speakers' }, prepare: seedSubscriber }),
    onStatus: 200,
    off: 'not found',
    needsSession: true,
    noSession: 404,
  },
  {
    flag: 'pro',
    name: 'POST /api/club/magic-link',
    env: clubEnv,
    run: (env, { uid }) => runClubDoor(env, { uid, path: '/api/club/magic-link', body: { email: BILLING_EMAIL }, prepare: withClub }),
    onStatus: 200,
    off: 'not found',
    needsSession: false,
  },
  {
    flag: 'pro',
    name: 'POST /api/club/manage',
    env: clubEnv,
    run: (env, { uid }) => runClubDoor(env, { uid, path: '/api/club/manage', prepare: seedMagicToken }),
    onStatus: 200,
    off: 'not found',
    needsSession: false,
  },
];

async function expectDark(off, res) {
  if (off === 'falls through') {
    expect(res).toBeNull();
    return;
  }
  expect(res.status).toBe(404);
  // Nothing on the wire says "flag": the same body as a mistyped URL.
  expect(await res.json()).toEqual({ error: 'Not found' });
}

describe('gated endpoints', () => {
  describe.each(GATED)('$name ($flag)', ({ flag, env: makeEnv, run, onStatus, off, needsSession, noSession }) => {
    // A billing route (or club creation) needs a session to do anything; a
    // sign-in route, or a club code typed by a guest, is usually called by nobody.
    const caller = { uid: needsSession ? 'u1' : null };

    it('behaves as it always has when the flag is on', async () => {
      const { res, didWork } = await run(makeEnv({ FLAGS_FORCE: '1' }), caller);
      expect(res.status).toBe(onStatus);
      expect(didWork).toBe(true);
    });

    it(`is dark (${off}), and does no work, when the flag is off`, async () => {
      const { res, didWork } = await run(makeEnv({ FLAGS_FORCE: '0' }), caller);
      await expectDark(off, res);
      expect(didWork).toBe(false);
    });

    it('is off by default: no override and no PostHog key means the fallback', async () => {
      const { res, didWork } = await run(makeEnv(), caller);
      await expectDark(off, res);
      expect(didWork).toBe(false);
    });

    if (needsSession) {
      it(`answers ${noSession} to a caller with no session while the flag is off, and 401 while it is on`, async () => {
        const dark = await run(makeEnv({ FLAGS_FORCE: '0' }), { uid: null });
        expect(dark.res.status).toBe(noSession);
        const lit = await run(makeEnv({ FLAGS_FORCE: '1' }), { uid: null });
        expect(lit.res.status).toBe(401);
      });
    }

    // The production use: PostHog targets one account, and only that account
    // gets through. For sign-in that account has to be carrying a session
    // already; a signed-out visitor asks as anonymous (the next case).
    it('follows PostHog\'s per-account answer', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const { distinct_id: id } = JSON.parse(init.body);
        return new Response(JSON.stringify(flagsAnswer({ [flag]: id === 'zoom:u1' })));
      }));
      const env = makeEnv({ POSTHOG_API_KEY: 'phc_test', PROFILES: makeKv({
        [customerByUidKey('u1')]: 'cus_1',
        [customerByUidKey('u2')]: 'cus_2',
      }) });

      const u1 = await run(env, { uid: 'u1' });
      expect(u1.res.status).toBe(onStatus);
      expect(u1.didWork).toBe(true);
      const u2 = await run(env, { uid: 'u2' });
      await expectDark(off, u2.res);
      expect(u2.didWork).toBe(false);
    });

    if (!needsSession) {
      it('asks as anonymous for a signed-out visitor, and follows the everyone position', async () => {
        const asked = [];
        let everyone = false;
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
          const { distinct_id: id } = JSON.parse(init.body);
          asked.push(id);
          return new Response(JSON.stringify(flagsAnswer({ [flag]: everyone })));
        }));
        const env = makeEnv({ POSTHOG_API_KEY: 'phc_test' });

        const dark = await run(env, { uid: null });
        await expectDark(off, dark.res);
        everyone = true;
        const lit = await run(env, { uid: null });
        expect(lit.res.status).toBe(onStatus);
        expect(asked).toEqual([ANONYMOUS_DISTINCT_ID, ANONYMOUS_DISTINCT_ID]);
      });
    }
  });

  // The success page in the system browser polls this with no session. It
  // reveals one paid/unpaid bit and stays open in both positions.
  it('leaves GET /api/billing/checkout-status ungated', async () => {
    for (const FLAGS_FORCE of ['0', '1']) {
      const stripe = fakeStripe();
      const res = await callBilling(billingEnv({ FLAGS_FORCE }), stripe, {
        path: '/api/billing/checkout-status', method: 'GET', uid: null, query: '?session_id=cs_test_abc',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ paid: true });
    }
  });

  // Signing out must always work, including for someone who signed in while
  // pro was on and is still holding the cookie after it went off.
  it('leaves POST /api/auth/logout ungated', async () => {
    const res = await worker.fetch(
      new Request('https://www.example.test/api/auth/logout', {
        method: 'POST',
        headers: { host: 'www.example.test', cookie: sessionCookieFor('u1') },
      }),
      authEnv({ FLAGS_FORCE: '0' }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^tt_session=; Path=\/; Max-Age=0/);
  });

  /**
   * The pro flag closes the doors and nothing else. Two clients read a 404
   * from inside a club as final: refreshClub leaves the club on a 404 from
   * GET /api/club, and drainOutbox drops a queued speech on any 4xx. So a
   * device that joined while pro was on has to keep working, unchanged, once
   * it goes off — these are what stop a future edit from evicting club devices.
   */
  describe('the pro flag leaves a device already in a club alone', () => {
    /** One store; a device joins while pro is on, then the flag moves. */
    async function joined() {
      const store = makeKv();
      const envAt = (FLAGS_FORCE) => clubEnv({ PROFILES: store, FLAGS_FORCE });
      const clubId = await seedClubOnce(envAt('1'));
      const { res } = await runClubDoor(envAt('1'), { path: '/api/club/activate', body: { code: 'DTSP-7K2QM9' } });
      const { clubToken } = await res.json();
      return { clubId, clubToken, envAt };
    }

    const call = (env, path, { method = 'GET', headers = {}, body } = {}) => {
      const url = new URL(`https://www.example.test${path}`);
      return handleClub(
        new Request(url, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        url,
        env,
        { ctx }
      );
    };

    it('answers the daily refresh, GET /api/club, with 200 while pro is off', async () => {
      const { clubToken, envAt } = await joined();

      const res = await call(envAt('0'), '/api/club', { headers: { 'x-club': clubToken } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ club: { name: 'Downtown Speakers' }, entitled: true });
    });

    it('still takes a queued speech while pro is off', async () => {
      const { clubToken, envAt } = await joined();

      const res = await call(envAt('0'), '/api/club/meetings/20260929/speeches', {
        method: 'POST',
        headers: { 'x-club': clubToken },
        body: { speechId: 's1', name: 'Alice', role: 'Standard Speech', duration: '5:50', color: 'green', finishedAt: 1_000 },
      });
      expect(res.status).toBe(200);
    });

    it('answers presets, meetings, the admin routes and admin sign-out the same in both positions', async () => {
      const { clubId, clubToken, envAt } = await joined();
      const adminCookie = `${ADMIN_COOKIE}=${mintAdminSession({ clubId, email: BILLING_EMAIL }, SIGNING_KEY)}`;
      const requests = [
        ['/api/club/presets', { method: 'PUT', headers: { 'x-club': clubToken }, body: {} }],
        ['/api/club/meetings', { headers: { 'x-club': clubToken } }],
        ['/api/club/roster', { headers: { cookie: adminCookie } }],
        ['/api/club/manage/signout', { method: 'POST' }],
      ];

      for (const [path, init] of requests) {
        const lit = await call(envAt('1'), path, init);
        const dark = await call(envAt('0'), path, init);
        expect(dark.status, path).toBe(lit.status);
        expect(dark.status, path).not.toBe(404);
      }
    });
  });
});

// ── Keeping the list honest ─────────────────────────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every non-test source file the flags could be read from. */
function sourceFiles() {
  const roots = ['worker', 'packages', ...readdirSync(join(repoRoot, 'apps')).map((app) => join('apps', app, 'src'))];
  const files = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, root), { recursive: true });
    } catch {
      continue; // an app without a src/ directory
    }
    for (const entry of entries) {
      const path = join(root, String(entry));
      if (path.split(/[\\/]/).includes('node_modules')) continue;
      if (!/\.(js|jsx)$/.test(path)) continue;
      if (/\.test\.(js|jsx)$/.test(path) || path.split(/[\\/]/).includes('__tests__')) continue;
      files.push(path);
    }
  }
  return files;
}

const REFERENCE_PATTERNS = [
  /\bflagEnabled\(\s*env\s*,\s*['"]([a-z0-9_]+)['"]/g,
  /\buseFlag\(\s*['"]([a-z0-9_]+)['"]\s*\)/g,
  /\bisFlagOn\(\s*['"]([a-z0-9_]+)['"]\s*\)/g,
  /<FlagGate\s+flag=['"]([a-z0-9_]+)['"]/g,
];

function referencedFlags() {
  const found = new Map();
  for (const path of sourceFiles()) {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        if (!found.has(match[1])) found.set(match[1], new Set());
        found.get(match[1]).add(relative(repoRoot, join(repoRoot, path)));
      }
    }
  }
  return found;
}

describe('the declared flags', () => {
  // The definitions live in a dashboard nobody can grep, so this list is the
  // only place a reviewer sees what exists. Both directions: a flag the code
  // reads but never declared always resolves false; a declared flag nothing
  // reads is a dead toggle left live in PostHog.
  it('every flag referenced in code is declared, and every declared flag is read', () => {
    const referenced = referencedFlags();
    const declared = new Set(Object.keys(FLAG_FALLBACKS));

    const undeclared = [...referenced.keys()].filter((key) => !declared.has(key));
    const stale = [...declared].filter((key) => !referenced.has(key));
    expect(undeclared, `referenced but not in FLAG_FALLBACKS: ${undeclared.map((k) => `${k} (${[...referenced.get(k)].join(', ')})`).join('; ')}`).toEqual([]);
    expect(stale, 'declared in FLAG_FALLBACKS but read nowhere').toEqual([]);
  });

  it('are all safe-off fallbacks', () => {
    // A true fallback is a released feature, and a released feature's flag is
    // deleted in the same commit rather than left with a true default.
    for (const [key, value] of Object.entries(FLAG_FALLBACKS)) {
      expect(value, key).toBe(false);
    }
    expect(Object.isFrozen(FLAG_FALLBACKS)).toBe(true);
  });

  // A guard on the scan itself: a broken pattern would otherwise make the
  // bidirectional check pass by finding nothing on either side. Each flag is
  // expected wherever it has a gate.
  it.each([
    ['pro', ['worker', join('apps', 'zoom-app'), join('apps', 'web')]],
    // App-only: the Worker endpoint it feeds is not gated, because the
    // browser doors save the same record unflagged.
    ['contact_capture', [join('apps', 'zoom-app')]],
  ])('sees the server gate and the UI gates for %s', (key, places) => {
    const files = [...(referencedFlags().get(key) ?? [])];
    for (const place of places) {
      expect(files.some((f) => f.startsWith(place)), `${key} in ${place}`).toBe(true);
    }
  });
});

/**
 * wrangler.jsonc as data. Comments here always sit on their own line, and the
 * file holds URLs, so only whole-line `//` comments are stripped.
 */
function readWranglerConfig() {
  const source = readFileSync(join(repoRoot, 'wrangler.jsonc'), 'utf8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
}

describe('FLAGS_FORCE in wrangler.jsonc', () => {
  const config = readWranglerConfig();

  // vars are not inherited by environments, and the convention is that no key
  // is in one block and missing from the other.
  it('is declared in both the production and the dev block', () => {
    expect(config.vars).toHaveProperty('FLAGS_FORCE');
    expect(config.env.dev.vars).toHaveProperty('FLAGS_FORCE');
  });

  it('is never "1" in production, which would light up every dark feature at once', () => {
    expect(config.vars.FLAGS_FORCE).not.toBe('1');
  });
});
