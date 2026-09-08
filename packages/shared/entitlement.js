/**
 * What the current user may use, as the client knows it.
 *
 * The server decides (see worker/entitlements.js); this module only remembers
 * the latest answer and tells the UI when it changes. Nothing here grants
 * anything: a client that lies to itself still gets 402 from the Worker.
 *
 * The answer arrives with the identity on load, again from GET /api/me when
 * asked, and inside any 402 the sync layer receives.
 */

const ME_ENDPOINT = '/api/me';

export const FREE_ENTITLEMENT = Object.freeze({
  plan: 'free',
  status: null,
  entitled: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'none',
});

let current = FREE_ENTITLEMENT;
// Until the first server answer we do not know, and the UI should not flash
// an upgrade banner at someone who is about to be told they are pro.
let known = false;
const listeners = new Set();

function normalize(value) {
  if (!value || typeof value !== 'object') return FREE_ENTITLEMENT;
  return {
    plan: value.plan === 'pro' ? 'pro' : 'free',
    status: typeof value.status === 'string' ? value.status : null,
    entitled: Boolean(value.entitled),
    currentPeriodEnd: typeof value.currentPeriodEnd === 'number' ? value.currentPeriodEnd : null,
    cancelAtPeriodEnd: Boolean(value.cancelAtPeriodEnd),
    source: typeof value.source === 'string' ? value.source : 'none',
  };
}

/** Record a fresh answer from the server and notify subscribers. */
export function setEntitlement(value) {
  current = normalize(value);
  known = true;
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // One bad subscriber must not stop the others hearing about it.
    }
  }
  return current;
}

export function getEntitlement() {
  return current;
}

/** Whether any server answer has arrived yet. */
export function isEntitlementKnown() {
  return known;
}

export function isPro(entitlement = current) {
  return entitlement?.plan === 'pro';
}

/**
 * @param {(entitlement: Object) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeEntitlement(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ask the server again. Returns the fresh entitlement, or null when there is
 * no session or the request failed (the stored answer is left as it was).
 *
 * @param {{getToken: () => string|null, fetchImpl?: typeof fetch, cookieSession?: boolean}} options
 */
export async function refreshEntitlement({ getToken, fetchImpl, cookieSession = false } = {}) {
  const token = getToken?.();
  if (!token && !cookieSession) return null;
  try {
    const response = await (fetchImpl ?? fetch)(ME_ENDPOINT, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = await response.json();
    return setEntitlement(body?.entitlement);
  } catch {
    return null;
  }
}

/**
 * Poll until the user is pro, or until time runs out.
 *
 * Used after Checkout is opened in the system browser: the Zoom webview never
 * sees Stripe's redirect, so it asks the Worker instead. The webhook and KV
 * are eventually consistent, so the copy around this should say "may take a
 * minute".
 *
 * @param {Object} options
 * @param {() => string|null} options.getToken
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.intervalMs]
 * @param {number} [options.timeoutMs]
 * @param {{aborted: boolean}} [options.signal] - set aborted=true to stop early
 * @param {(ms: number) => Promise<void>} [options.sleep] - injectable for tests
 * @returns {Promise<boolean>} true once pro
 */
export async function waitForPro({
  getToken,
  fetchImpl,
  intervalMs = 5000,
  timeoutMs = 10 * 60 * 1000,
  signal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted) {
    const fresh = await refreshEntitlement({ getToken, fetchImpl });
    if (fresh && isPro(fresh)) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
  return false;
}

/** Test seam. */
export function resetEntitlementForTests() {
  current = FREE_ENTITLEMENT;
  known = false;
  listeners.clear();
}
