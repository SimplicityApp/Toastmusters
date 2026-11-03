import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { AlertTriangle, X } from 'lucide-react'
import { readSigninFailure } from '../utils/signinFailure'
import SignInFailureActions from './SignInFailureActions'

/**
 * The one place a failed sign-in is guaranteed to be seen.
 *
 * The header's sign-in link sends the user back to whatever page they clicked
 * it from, so a failure can land on the landing page, the timer, or the club
 * console — none of which knew to look for it, which made a broken sign-in
 * indistinguishable from never having signed in. Rendered above every route
 * instead of per page, so a new route cannot forget it.
 *
 * /account is skipped: it renders the same message inside its own layout,
 * where it reads as part of the page rather than as an interruption.
 */
export default function SignInFailureNotice() {
  const [searchParams] = useSearchParams()
  const { pathname } = useLocation()
  const [dismissed, setDismissed] = useState(false)

  const failure = readSigninFailure(searchParams)
  if (!failure || dismissed || pathname === '/account') return null

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="flex-1">
        <p>{failure.message}</p>
        <SignInFailureActions failure={failure} surface="banner" tone="light" />
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="flex-shrink-0 text-amber-900/60 hover:text-amber-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
