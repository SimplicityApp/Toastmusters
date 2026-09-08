import {
  initProfileSync,
  syncCardAssets,
  setEntitlement,
  subscribeEntitlement,
  FREE_ENTITLEMENT,
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

const ME_ENDPOINT = '/api/me'
const ANONYMOUS = Object.freeze({ identified: false, uid: null, entitlement: null })

let identityPromise = null

async function resolveOnce() {
  try {
    const response = await fetch(ME_ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return { ...ANONYMOUS }
    const body = await response.json()
    if (!body?.uid) return { ...ANONYMOUS }
    return { identified: true, uid: body.uid, entitlement: body.entitlement ?? null }
  } catch {
    return { ...ANONYMOUS }
  }
}

/** @returns {Promise<{identified: boolean, uid: string|null, entitlement: Object|null}>} never rejects */
export function resolveWebIdentity() {
  if (!identityPromise) identityPromise = resolveOnce().catch(() => ({ ...ANONYMOUS }))
  return identityPromise
}

/** Where a "Sign in with Zoom" link should point, coming back to `returnTo`. */
export function signInUrl(returnTo = '/app') {
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
}

/**
 * Tie the page to the signed-in user, if any: analytics identity and the same
 * settings/artwork sync the Zoom app runs. Not awaited by the caller; nothing
 * about rendering waits on it.
 */
export async function startWebSession() {
  const identity = await resolveWebIdentity()
  setEntitlement(identity.entitlement ?? FREE_ENTITLEMENT)
  setUserProperties({ surface: 'web', web_signed_in: identity.identified })
  if (!identity.identified) return identity

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

  await startSync().catch(() => {})
  return identity
}

/** Test seam. */
export function resetWebIdentityForTests() {
  identityPromise = null
}
