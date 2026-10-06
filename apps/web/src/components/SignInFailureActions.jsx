import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { trackEvent } from '../utils/posthog'
import { retryReturnTo } from '../utils/signinFailure'
import { signInUrl } from '../utils/webIdentity'

/**
 * The way out of a failed sign-in, under whichever notice is showing it.
 *
 * Every failure message already says "try again"; before this, none of them
 * offered a way to do it. Shared by the global strip and the inline /account
 * notice so the two cannot drift apart, and so the recovery funnel is recorded
 * in one place: `signin_failure_shown` fires when this mounts, which is exactly
 * when a notice is visible, and each fix records its own click. The strip
 * skips /account, so only one surface fires on any page.
 *
 * "Sign in again" comes back to the same page with the failure params removed,
 * so a successful retry does not bring the old notice straight back. (The
 * Worker strips them on success too, for links built elsewhere.)
 *
 * @param {Object} props
 * @param {{reason: string, message: string, scopeIssue: boolean}} props.failure - from readSigninFailure
 * @param {'banner'|'account'} props.surface - which notice, for analytics
 * @param {'light'|'dark'} [props.tone] - light for the amber strip, dark for the /account card
 */

const TONES = {
  light: {
    primary: 'bg-amber-600 text-white hover:bg-amber-700',
  },
  dark: {
    primary: 'bg-white text-gray-900 hover:bg-gray-100',
  },
}

export default function SignInFailureActions({ failure, surface, tone = 'light' }) {
  const location = useLocation()
  const { reason } = failure
  const palette = TONES[tone] || TONES.light

  useEffect(() => {
    trackEvent('signin_failure_shown', { reason, surface })
  }, [reason, surface])

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
      <a
        href={signInUrl(retryReturnTo(location))}
        onClick={() => trackEvent('signin_retry_clicked', { reason, surface })}
        className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold no-underline ${palette.primary}`}
        data-testid="signin-retry"
      >
        Sign in again
      </a>
    </div>
  )
}
