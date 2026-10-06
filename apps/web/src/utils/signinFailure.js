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

/**
 * @param {URLSearchParams} searchParams
 * @returns {string|null} the line to show, or null when this is not a failure
 */
export function signinFailureMessage(searchParams) {
  if (searchParams?.get('signin') !== 'failed') return null
  const reason = searchParams.get('reason')
  // Own keys only: `?reason=toString` must not hand back a function.
  return (reason && Object.hasOwn(SIGNIN_ERRORS, reason) && SIGNIN_ERRORS[reason]) || SIGNIN_ERRORS.failed
}
