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

const SIGNIN_ERRORS = {
  denied: 'You closed the Zoom sign-in without allowing it.',
  state_mismatch: 'The sign-in link had expired. Please try again.',
  exchange: 'Zoom did not accept the sign-in. Please try again.',
  profile: 'Zoom did not share your account id. Please try again later.',
  failed: 'Sign-in did not finish. Please try again.',
}

/**
 * @param {URLSearchParams} searchParams
 * @returns {string|null} the line to show, or null when this is not a failure
 */
export function signinFailureMessage(searchParams) {
  if (searchParams?.get('signin') !== 'failed') return null
  return SIGNIN_ERRORS[searchParams.get('reason')] || SIGNIN_ERRORS.failed
}
