/**
 * Why "Sign in with Zoom" did not finish.
 *
 * The Worker cannot render anything itself — it can only redirect — so it puts
 * the reason in the query string of wherever the user was headed
 * (`?signin=failed&reason=…`, see worker/auth.js). These are the strings that
 * turns into. Shared rather than owned by /account, because the sign-in link in
 * the header carries whatever page it was clicked from as `returnTo`, so the
 * failure can land anywhere.
 */

export const SIGNIN_ERRORS = {
  denied: 'You closed the Zoom sign-in without allowing it.',
  state_mismatch: 'The sign-in link had expired. Please try again.',
  exchange: 'Zoom did not accept the sign-in. Please try again.',
  profile: 'Zoom did not share your account id. Please try again later.',
  // Zoom completed the sign-in but the token lacks user:read:user, so the
  // Worker could not read who this is. Not an outage: retrying without
  // granting the permission fails the same way, so the copy says what to do.
  scope_not_granted:
    "Zoom signed you in but didn't give Toastmusters Timer permission to see your account. " +
    "Sign in again and click Allow on Zoom's screen. If Zoom doesn't ask, remove and re-add the app in Zoom.",
  failed: 'Sign-in did not finish. Please try again.',
}

/** Query params the Worker adds to a failed sign-in's return URL. */
const SIGNIN_PARAMS = ['signin', 'reason']

/**
 * What a failed sign-in looks like to the notices that show it.
 *
 * `reason` is the raw query value, kept for analytics: an unknown reason still
 * shows the generic message, but reports what the Worker actually sent.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{reason: string, message: string, scopeIssue: boolean}|null}
 *   null when this is not a failure
 */
export function readSigninFailure(searchParams) {
  if (searchParams?.get('signin') !== 'failed') return null
  const reason = searchParams.get('reason') || 'failed'
  // Own keys only: `?reason=toString` must not hand back a function.
  const message = (Object.hasOwn(SIGNIN_ERRORS, reason) && SIGNIN_ERRORS[reason]) || SIGNIN_ERRORS.failed
  return { reason, message, scopeIssue: reason === 'scope_not_granted' }
}

/**
 * Where "Sign in again" should come back to: the current page, minus the
 * failure params. Without this a successful retry would land on a URL that
 * still says `?signin=failed`, and the old notice would come straight back.
 * Every other param and the hash are kept.
 *
 * @param {{pathname: string, search?: string, hash?: string}} location
 * @returns {string}
 */
export function retryReturnTo(location) {
  const params = new URLSearchParams(location?.search || '')
  for (const name of SIGNIN_PARAMS) params.delete(name)
  const search = params.toString()
  return `${location?.pathname || '/'}${search ? `?${search}` : ''}${location?.hash || ''}`
}
