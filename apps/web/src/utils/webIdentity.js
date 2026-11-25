import {
  initProfileSync,
  syncCardAssets,
  setEntitlement,
  subscribeEntitlement,
  FREE_ENTITLEMENT,
  setFlags,
  syncClubWithIdentity,
  forgetClub,
} from '@toastmaster-timer/shared'
import { identifyUser, setUserProperties } from './posthog'

/**
 * Who is using the web app.
 *
 * The browser has no Zoom context, so identity here comes from a session cookie
 * set by "Sign in with Zoom" (see worker/auth.js). This asks the Worker once per
 * page load and shares the answer with every caller. Anonymous is the normal
 * state: the timer works fully without signing in.
 */

// ?flags=1 asks for the release flags as well (see worker/flags.js). Only this
// identity call sends it: refreshEntitlement and waitForPro poll the bare
// /api/me, which keeps flag resolution at one request per page load.
const ME_ENDPOINT = '/api/me?flags=1'
// `flags: null` for when the Worker could not be reached: the flag store reads
// it as "answered, all off", so nothing gated waits forever. `reachable` says
// whether it answered at all, which is what the club copy is applied on.
const ANONYMOUS = Object.freeze({ identified: false, uid: null, entitlement: null, flags: null, reachable: false })

let identityPromise = null

async function resolveOnce() {
  try {
    const response = await fetch(ME_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
    let body = null
    try {
      body = await response.json()
    } catch {
      // A 401 or a proxy error page need not be JSON; that is still anonymous.
    }
    // Read before the uid check: a signed-out visitor gets `{ uid: null, flags }`
    // and still has to end the load knowing which features to show.
    const flags = body?.flags ?? null
    // A 401 is an answer; a 5xx is a Worker (or the edge in front of it) that
    // could not give one.
    const reachable = response.status < 500
    if (!response.ok || !body?.uid) return { ...ANONYMOUS, flags, reachable }
    return { identified: true, uid: body.uid, entitlement: body.entitlement ?? null, flags, reachable }
  } catch {
    return { ...ANONYMOUS }
  }
}

/**
 * @returns {Promise<{identified: boolean, uid: string|null, entitlement: Object|null,
 *   flags: Object|null, reachable: boolean}>} never rejects
 */
export function resolveWebIdentity() {
  if (!identityPromise) identityPromise = resolveOnce().catch(() => ({ ...ANONYMOUS }))
  return identityPromise
}

/** Where a "Sign in with Zoom" link should point, coming back to `returnTo`. */
export function signInUrl(returnTo = '/timer/app') {
  return `/api/auth/zoom/start?returnTo=${encodeURIComponent(returnTo)}`
}

/** Forget the web session. Resolves even if the network is gone. */
export async function signOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    // The cookie may survive, but the page reload below shows the truth.
  }
  identityPromise = null
  // The club belongs to the account that just signed out, not to this browser.
  forgetClub()
}

/**
 * Tie the page to the signed-in user, if any: analytics identity and the same
 * settings/artwork sync the Zoom app runs. Not awaited by the caller; nothing
 * about rendering waits on it.
 */
export async function startWebSession() {
  const identity = await resolveWebIdentity()
  // An /api/me that never answered says nothing about the plan, so a club
  // member offline keeps the Pro their club copy gives them below.
  if (identity.reachable) setEntitlement(identity.entitlement ?? FREE_ENTITLEMENT)
  // The club, now that the account is known (#167): refreshed for this
  // account, forgotten for any other or for a signed-out browser. Offline the
  // browser can't tell whose its cookie is, so, like Zoom while it says
  // authorized, it trusts its copy. The forgetting happens before the flags
  // below can switch club features on.
  const clubSynced = syncClubWithIdentity({
    identified: identity.identified,
    uid: identity.uid,
    authStatus: identity.identified || !identity.reachable ? 'authorized' : 'unauthenticated',
    reachable: identity.reachable,
    entitlement: identity.entitlement,
  }).catch(() => null)
  // In the same breath as the entitlement, so a flag-gated control and an
  // entitlement-gated one appear together. Held for the whole page; nothing
  // re-asks.
  setFlags(identity.flags)
  setUserProperties({ surface: 'web', web_signed_in: identity.identified })
  if (!identity.identified) {
    await clubSynced
    return identity
  }

  // Same namespace as the Zoom app, so one person is one person in PostHog.
  identifyUser(`zoom:${identity.uid}`)

  const onUpgradeRequired = (fresh) => setEntitlement(fresh ?? FREE_ENTITLEMENT)
  const startSync = () =>
    initProfileSync({ getToken: () => null, cookieSession: true, onUpgradeRequired }).then(() =>
      syncCardAssets({ getToken: () => null, cookieSession: true, onUpgradeRequired })
    )

  let wasPro = identity.entitlement?.plan === 'pro'
  subscribeEntitlement((next) => {
    const nowPro = next.plan === 'pro'
    if (nowPro && !wasPro) startSync().catch(() => {})
    wasPro = nowPro
  })

  await Promise.all([startSync().catch(() => {}), clubSynced])
  return identity
}

/** Test seam. */
export function resetWebIdentityForTests() {
  identityPromise = null
}
