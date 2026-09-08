import { Link, useLocation } from 'react-router-dom'
import { Sparkles, UserRound } from 'lucide-react'
import { useEntitlement, useWebIdentity } from '../hooks/useEntitlement'
import { signInUrl } from '../utils/webIdentity'

/**
 * "Sign in with Zoom" or a link to the account page, for headers.
 *
 * Renders nothing until the Worker has said whether there is a session, so
 * signed-in users never see a sign-in button flash. `compact` is the small
 * variant for the timer's top bar.
 */
export default function AccountMenu({ compact = false }) {
  const identity = useWebIdentity()
  const { isPro, known } = useEntitlement()
  const location = useLocation()

  if (!identity) return null

  const returnTo = `${location.pathname}${location.search}` || '/app'
  const base = compact
    ? 'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors'
    : 'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors'

  if (!identity.identified) {
    return (
      <a
        href={signInUrl(returnTo)}
        className={`${base} ${compact ? 'text-gray-500 hover:text-gray-700 hover:bg-gray-100' : 'text-ink hover:bg-stone-900/5'}`}
        data-testid="sign-in-with-zoom"
      >
        <UserRound className="h-4 w-4" />
        Sign in with Zoom
      </a>
    )
  }

  return (
    <Link
      to="/account"
      className={`${base} ${compact ? 'text-gray-600 hover:text-gray-800 hover:bg-gray-100' : 'text-ink hover:bg-stone-900/5'}`}
      data-testid="account-link"
    >
      {known && isPro ? <Sparkles className="h-4 w-4 text-amber-500" /> : <UserRound className="h-4 w-4" />}
      {known && isPro ? 'Pro' : 'Account'}
    </Link>
  )
}
