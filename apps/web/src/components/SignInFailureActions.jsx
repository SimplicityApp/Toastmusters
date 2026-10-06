import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { ZOOM_MANAGE_APPS_URL, ZOOM_SIGNIN_PERMISSION_HELP_URL } from '@toastmaster-timer/shared'
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
 * A missing permission (`scope_not_granted`) gets two more ways out, both in a
 * new tab so the retry stays one click away. **Manage in Zoom** opens the
 * user's added apps in the Marketplace, for when Zoom quietly reuses the old
 * grant and never shows its consent screen again: removing and re-adding the
 * app forces it. **Why does Zoom ask?** explains the permission, for users who
 * declined it on purpose.
 *
 * @param {Object} props
 * @param {{reason: string, message: string, scopeIssue: boolean}} props.failure - from readSigninFailure
 * @param {'banner'|'account'} props.surface - which notice, for analytics
 * @param {'light'|'dark'} [props.tone] - light for the amber strip, dark for the /account card
 */

const TONES = {
  light: {
    primary: 'bg-amber-600 text-white hover:bg-amber-700',
    secondary: 'border border-stone-300 bg-white text-ink hover:bg-stone-50',
    link: 'text-amber-900 underline hover:text-amber-950',
  },
  dark: {
    primary: 'bg-white text-gray-900 hover:bg-gray-100',
    secondary: 'bg-white/10 text-white hover:bg-white/20',
    link: 'text-amber-200 underline hover:text-amber-100',
  },
}

const BUTTON = 'inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold no-underline'

export default function SignInFailureActions({ failure, surface, tone = 'light' }) {
  const location = useLocation()
  const { reason, scopeIssue } = failure
  const palette = TONES[tone] || TONES.light

  useEffect(() => {
    trackEvent('signin_failure_shown', { reason, surface })
  }, [reason, surface])

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
      <a
        href={signInUrl(retryReturnTo(location))}
        onClick={() => trackEvent('signin_retry_clicked', { reason, surface })}
        className={`${BUTTON} ${palette.primary}`}
        data-testid="signin-retry"
      >
        Sign in again
      </a>
      {scopeIssue && (
        <>
          <a
            href={ZOOM_MANAGE_APPS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('zoom_manage_app_clicked', { reason, surface })}
            className={`${BUTTON} ${palette.secondary}`}
            data-testid="signin-manage-in-zoom"
          >
            Manage in Zoom
          </a>
          <a
            href={ZOOM_SIGNIN_PERMISSION_HELP_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent('signin_help_clicked', { reason, surface })}
            className={`text-xs ${palette.link}`}
            data-testid="signin-help"
          >
            Why does Zoom ask?
          </a>
        </>
      )}
    </div>
  )
}
