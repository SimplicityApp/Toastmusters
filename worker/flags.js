/**
 * Release flags: "is this code path switched on yet?"
 *
 * Not entitlement. Whether someone is paying stays in worker/entitlements.js;
 * a flag never grants Pro to anyone. It only decides whether unfinished work is
 * visible at all, so it can merge to master dark and be turned on for named
 * accounts in production without a deploy.
 *
 * PostHog owns the definitions and the targeting (its dashboard is where a flag
 * is flipped). This module owns the evaluation and the fallback. It asks
 * PostHog once per session, against the same `zoom:<uid>` distinct id both
 * apps already identify with, so one release condition targets a person on the
 * web app and in the Zoom app at once.
 *
 * Called only from the paths that establish a session, never from the
 * entitlement pollers: that is what keeps it at about one request per app load.
 */

// PostHog is the source of truth for whether a flag is on. This list exists so
// the code declares what it reads, and so a PostHog outage is a no-op rather
// than a silent dark-out of features that are already live.
//
// The value is the *safe* one, not the current one. Flipping an entry to true
// is declaring the feature permanently released, and belongs in the same commit
// that deletes the flag from the code. worker/flags.test.js fails if this list
// and the code's flagEnabled/useFlag references drift apart in either direction.
export const FLAG_FALLBACKS = Object.freeze({
  pro_billing: false, // Stripe checkout, portal, and the Upgrade path. removeBy: 2026-12-31
});

// The ingestion host, called directly rather than through the browser's
// e.simple-tech.app proxy: this is server-side traffic with the same project
// key worker/zoom-webhook.js already uses for capture.
const POSTHOG_FLAGS_URL = 'https://us.i.posthog.com/flags?v=2';

// Long enough for a healthy round trip, short enough that a slow PostHog never
// holds up the session response it rides in. On timeout the fallbacks apply.
export const FLAGS_TIMEOUT_MS = 1500;

// Bounds how long a flip in the dashboard takes to reach a new session.
const CACHE_TTL_SECONDS = 60;

// Guests and anonymous loads have no distinct id to ask about. They share this
// one, so they get the everyone-on / everyone-off position and are never part
// of a partial rollout.
export const ANONYMOUS_DISTINCT_ID = 'anonymous';

/**
 * The synthetic edge-cache key for one distinct id. Per id on purpose: a shared
 * key would serve the anonymous answer to an identified user and silently
 * defeat single-account targeting.
 *
 * @param {string} distinctId
 */
export function flagCacheKey(distinctId) {
  return `https://flags.internal/${encodeURIComponent(distinctId)}`;
}

/**
 * The per-environment short circuit, set in wrangler.jsonc like
 * ENTITLEMENT_ENFORCE: '1' → every flag on, '0' → every flag off, anything
 * else (including unset) → ask PostHog.
 *
 * @returns {boolean|null}
 */
export function flagOverride(env) {
  if (env?.FLAGS_FORCE === '1') return true;
  if (env?.FLAGS_FORCE === '0') return false;
  return null;
}

const allFlags = (value) => Object.fromEntries(Object.keys(FLAG_FALLBACKS).map((key) => [key, value]));

/**
 * The declared keys only, each from `read(key)` when that is a boolean and from
 * the fallback otherwise. Keys PostHog knows and the code does not are dropped.
 */
function mergeWithFallbacks(read) {
  const merged = {};
  for (const [key, fallback] of Object.entries(FLAG_FALLBACKS)) {
    const value = read(key);
    merged[key] = typeof value === 'boolean' ? value : fallback;
  }
  return merged;
}

/**
 * One POST to PostHog, bounded by FLAGS_TIMEOUT_MS end to end (headers and
 * body). Rejects on anything that is not a usable answer.
 */
async function askPostHog(env, distinctId) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`PostHog /flags timed out after ${FLAGS_TIMEOUT_MS}ms`));
    }, FLAGS_TIMEOUT_MS);
  });

  const request = (async () => {
    const res = await fetch(POSTHOG_FLAGS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_API_KEY, distinct_id: distinctId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`PostHog /flags returned ${res.status}`);
    return res.json();
  })();

  try {
    const answer = await Promise.race([request, timeout]);
    // Over the free quota PostHog answers 200 with every flag missing. Treated
    // as a failure so the fallbacks apply, rather than reading it as "all off".
    if (Array.isArray(answer?.quotaLimited) && answer.quotaLimited.includes('feature_flags')) {
      throw new Error('PostHog /flags is quota limited');
    }
    if (!answer?.flags || typeof answer.flags !== 'object' || Array.isArray(answer.flags)) {
      throw new Error('PostHog /flags returned an unexpected shape');
    }
    return answer.flags;
  } finally {
    clearTimeout(timer);
    // Nothing is left listening once the race is decided.
    request.catch(() => {});
  }
}

/**
 * Every declared flag's position for this caller. Never rejects: any failure
 * at all (no key, timeout, 5xx, quota, a malformed body, a throwing cache)
 * returns FLAG_FALLBACKS, so a PostHog outage never darks a released feature.
 *
 * The contract is the thing to keep if the body changes: local evaluation
 * would be a swap of what happens below, not a redesign.
 *
 * @param {Object} env - Worker env (FLAGS_FORCE, POSTHOG_API_KEY)
 * @param {{uid?: string|null}} [caller] - the raw Zoom uid, when there is one
 * @param {{waitUntil: (p: Promise) => void}} [ctx]
 * @returns {Promise<Object<string, boolean>>}
 */
export async function resolveFlags(env, { uid } = {}, ctx) {
  const override = flagOverride(env);
  if (override !== null) return allFlags(override);
  if (!env?.POSTHOG_API_KEY) return FLAG_FALLBACKS;

  const distinctId = uid ? `zoom:${uid}` : ANONYMOUS_DISTINCT_ID;
  // caches is a Workers global; absent under vitest's node environment.
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(flagCacheKey(distinctId));

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const stored = await cached.json();
        // Re-merged, so a key declared since the entry was written still gets
        // its fallback instead of reading as missing.
        return mergeWithFallbacks((key) => stored?.[key]);
      }
    } catch {
      // A cache that cannot be read is only a miss: PostHog is still there.
    }
  }

  let merged;
  try {
    const flags = await askPostHog(env, distinctId);
    merged = mergeWithFallbacks((key) => flags[key]?.enabled);
  } catch (err) {
    // Not cached, so the next session retries rather than pinning the fallback.
    console.warn('flags: falling back to checked-in values:', err?.message || err);
    return FLAG_FALLBACKS;
  }

  if (cache && ctx) {
    try {
      const response = new Response(JSON.stringify(merged), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${CACHE_TTL_SECONDS}`,
        },
      });
      ctx.waitUntil(Promise.resolve(cache.put(cacheKey, response)).catch(() => {}));
    } catch {
      // Caching is insurance, not load-bearing: the answer is still good.
    }
  }
  return merged;
}

/**
 * One flag, for a server gate. A dark feature is refused before it does any
 * work, with a 404 that looks like any other unknown URL.
 *
 * @param {Object} env
 * @param {string} key - must be declared in FLAG_FALLBACKS
 * @param {{uid?: string|null}} [caller]
 * @param {{waitUntil: (p: Promise) => void}} [ctx]
 * @returns {Promise<boolean>}
 */
export async function flagEnabled(env, key, { uid } = {}, ctx) {
  const flags = await resolveFlags(env, { uid }, ctx);
  return flags[key] === true;
}
