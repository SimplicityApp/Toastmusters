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
import { mintSessionToken } from './session-token.js';

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
    vi.stubGlobal('fetch', respondWith({ flags: { pro_billing: { key: 'pro_billing', enabled: 'yes' } } }));

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
      for (const body of ['not json', {}, { flags: null }, { flags: [] }, { flags: 'pro_billing' }, []]) {
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
  it('answers one declared flag as a boolean', async () => {
    expect(await flagEnabled({ FLAGS_FORCE: '1' }, 'pro_billing')).toBe(true);
    expect(await flagEnabled({ FLAGS_FORCE: '0' }, 'pro_billing')).toBe(false);
    expect(await flagEnabled({}, 'pro_billing')).toBe(FLAG_FALLBACKS.pro_billing);
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

const GATED = [
  {
    flag: 'pro_billing',
    name: 'POST /api/billing/checkout',
    call: { path: '/api/billing/checkout', body: { interval: 'monthly' } },
    didWork: (stripe) => stripe.createCheckoutSession,
  },
  {
    flag: 'pro_billing',
    name: 'POST /api/billing/portal',
    call: { path: '/api/billing/portal' },
    didWork: (stripe) => stripe.createPortalSession,
  },
];

describe('gated endpoints', () => {
  describe.each(GATED)('$name ($flag)', ({ call, didWork }) => {
    it('behaves as it always has when the flag is on', async () => {
      const stripe = fakeStripe();
      const res = await callBilling(billingEnv({ FLAGS_FORCE: '1' }), stripe, call);
      expect(res.status).toBe(200);
      expect(didWork(stripe)).toHaveBeenCalledTimes(1);
    });

    it('answers a bare 404, and does no work, when the flag is off', async () => {
      const stripe = fakeStripe();
      const res = await callBilling(billingEnv({ FLAGS_FORCE: '0' }), stripe, call);
      expect(res.status).toBe(404);
      // Nothing on the wire says "flag": the same body as a mistyped URL.
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(didWork(stripe)).not.toHaveBeenCalled();
    });

    it('is off by default: no override and no PostHog key means the fallback', async () => {
      const stripe = fakeStripe();
      expect((await callBilling(billingEnv(), stripe, call)).status).toBe(404);
      expect(didWork(stripe)).not.toHaveBeenCalled();
    });

    it('still answers 401 to a caller with no session, whatever the flag says', async () => {
      const stripe = fakeStripe();
      expect((await callBilling(billingEnv({ FLAGS_FORCE: '0' }), stripe, { ...call, uid: null })).status).toBe(401);
    });

    // The production use: PostHog targets one account, and only that account
    // gets through.
    it('follows PostHog\'s per-account answer', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const { distinct_id: id } = JSON.parse(init.body);
        return new Response(JSON.stringify(flagsAnswer({ pro_billing: id === 'zoom:u1' })));
      }));
      const env = billingEnv({ POSTHOG_API_KEY: 'phc_test', PROFILES: makeKv({
        [customerByUidKey('u1')]: 'cus_1',
        [customerByUidKey('u2')]: 'cus_2',
      }) });

      expect((await callBilling(env, fakeStripe(), { ...call, uid: 'u1' })).status).toBe(200);
      expect((await callBilling(env, fakeStripe(), { ...call, uid: 'u2' })).status).toBe(404);
    });
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

  it('sees both the server gate and the UI gate for pro_billing', () => {
    // A guard on the scan itself: a broken pattern would otherwise make the
    // bidirectional check pass by finding nothing on either side.
    const files = [...(referencedFlags().get('pro_billing') ?? [])];
    expect(files.some((f) => f.startsWith('worker'))).toBe(true);
    expect(files.some((f) => f.startsWith(join('apps', 'zoom-app')))).toBe(true);
    expect(files.some((f) => f.startsWith(join('apps', 'web')))).toBe(true);
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
