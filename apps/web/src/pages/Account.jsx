import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Sparkles, Check, ExternalLink, LogOut } from 'lucide-react'
import { refreshEntitlement } from '@toastmaster-timer/shared'
import { useEntitlement, useWebIdentity } from '../hooks/useEntitlement'
import { signInUrl, signOut } from '../utils/webIdentity'
import { trackEvent } from '../utils/posthog'

/**
 * The signed-in user's plan, and the way to buy or manage it from the web.
 *
 * On the web Checkout can simply navigate: Stripe sends the browser back to
 * /billing/success, and the next load of this page asks the Worker again.
 */

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body: json }
}

const SIGNIN_ERRORS = {
  denied: 'You closed the Zoom sign-in without allowing it.',
  state_mismatch: 'The sign-in link had expired. Please try again.',
  exchange: 'Zoom did not accept the sign-in. Please try again.',
  profile: 'Zoom did not share your account id. Please try again later.',
  failed: 'Sign-in did not finish. Please try again.',
}

export default function Account() {
  const identity = useWebIdentity()
  const { entitlement, isPro, known } = useEntitlement()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const signinFailure = searchParams.get('signin') === 'failed' ? SIGNIN_ERRORS[searchParams.get('reason')] || SIGNIN_ERRORS.failed : null

  useEffect(() => {
    trackEvent('account_page_viewed', { signed_in: Boolean(identity?.identified) })
  }, [identity?.identified])

  // Back from Stripe? Ask again in case the webhook landed while we were away.
  useEffect(() => {
    if (identity?.identified) refreshEntitlement({ getToken: () => null, cookieSession: true })
  }, [identity?.identified])

  const handleCheckout = async (interval) => {
    setBusy(interval)
    setError(null)
    trackEvent('checkout_started', { source: 'web_account', interval })
    const { ok, body } = await postJson('/api/billing/checkout', { interval })
    if (!ok || !body.url) {
      setBusy(null)
      setError(body.error === 'Plan is not available' ? 'Plans are not set up yet. Please try again later.' : 'Could not start checkout. Please try again.')
      trackEvent('checkout_failed', { source: 'web_account', interval, reason: body.error || 'unknown' })
      return
    }
    window.location.assign(body.url)
  }

  const handlePortal = async () => {
    setBusy('portal')
    setError(null)
    trackEvent('billing_portal_opened', { source: 'web_account' })
    const { ok, body } = await postJson('/api/billing/portal')
    if (!ok || !body.url) {
      setBusy(null)
      setError('Could not open the billing page. Please try again.')
      return
    }
    window.location.assign(body.url)
  }

  const handleSignOut = async () => {
    setBusy('signout')
    await signOut()
    trackEvent('signed_out', { surface: 'web' })
    window.location.assign('/')
  }

  const renderPlan = () => {
    if (!known) return <p className="text-gray-300">Checking your plan…</p>

    if (isPro) {
      return (
        <>
          <div className="flex items-center gap-2 text-amber-300">
            <Sparkles className="h-5 w-5" />
            <span className="text-lg font-semibold">Pro</span>
          </div>
          <p className="mt-2 text-gray-300">
            {entitlement.source === 'grant'
              ? 'Complimentary access.'
              : entitlement.cancelAtPeriodEnd && entitlement.currentPeriodEnd
                ? `Ends on ${new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.`
                : entitlement.currentPeriodEnd
                  ? `Renews on ${new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.`
                  : 'Active.'}
            {' '}Your settings and card artwork follow you between the web and Zoom.
          </p>
          {entitlement.source !== 'grant' && (
            <button
              onClick={handlePortal}
              disabled={busy === 'portal'}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 font-medium text-white hover:bg-white/20 disabled:opacity-60"
            >
              <ExternalLink className="h-4 w-4" />
              Manage billing
            </button>
          )}
        </>
      )
    }

    return (
      <>
        <span className="text-lg font-semibold text-white">Free</span>
        <p className="mt-2 text-gray-300">The timer, agenda and reports, on this device.</p>
        <ul className="mt-4 space-y-1.5 text-gray-200">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Pro: timing rules, roles and agenda follow you to every computer and into Zoom</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Pro: custom card artwork backed up and synced</li>
        </ul>
        {entitlement.status && entitlement.currentPeriodEnd && (
          <p className="mt-3 text-sm text-gray-400">Your previous plan ended on {new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.</p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {[
            ['monthly', 'Monthly', 'Cancel any time'],
            ['yearly', 'Yearly', 'Two months free'],
          ].map(([interval, label, hint]) => (
            <button
              key={interval}
              onClick={() => handleCheckout(interval)}
              disabled={Boolean(busy)}
              className="flex flex-col items-center rounded-lg bg-blue-500 px-4 py-3 text-white hover:bg-blue-600 disabled:opacity-60"
            >
              <span className="font-semibold">{label}</span>
              <span className="text-xs opacity-90">{hint}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-center text-xs text-gray-400">Secure checkout by Stripe. Prices are shown there.</p>
      </>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-black/25 backdrop-blur-md border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-3 no-underline text-white">
            <img src="/Toastmasters-Timer-logo.jpg" alt="Toastmusters Timer" className="h-10 w-10 rounded-xl object-cover shadow-sm ring-1 ring-white/20" />
            <h1 className="text-xl font-semibold">Toastmusters Timer</h1>
          </Link>
          <Link to="/app" className="ml-auto text-sm text-gray-300 hover:text-white">Open the timer</Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold">Your account</h2>

        {signinFailure && (
          <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200" role="alert">
            {signinFailure}
          </p>
        )}

        {identity === null ? (
          <p className="mt-6 text-gray-300">Loading…</p>
        ) : !identity.identified ? (
          <div className="mt-6 rounded-2xl bg-black/30 border border-white/10 px-6 py-8">
            <p className="text-gray-200">
              Sign in with your Zoom account to see your plan and to have your settings follow you
              between this browser and the Zoom app. No password: Zoom confirms who you are.
            </p>
            <a
              href={signInUrl('/account')}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 font-semibold text-gray-900 hover:bg-gray-100 no-underline"
              data-testid="sign-in-with-zoom"
            >
              Sign in with Zoom
            </a>
          </div>
        ) : (
          <>
            <section className="mt-6 rounded-2xl bg-black/30 border border-white/10 px-6 py-6">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Plan</h3>
              <div className="mt-2">{renderPlan()}</div>
              {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
            </section>

            <section className="mt-6 rounded-2xl bg-black/30 border border-white/10 px-6 py-6">
              <h3 className="text-sm uppercase tracking-wide text-gray-400">Signed in</h3>
              <p className="mt-2 text-gray-300">Through Zoom. We hold your Zoom user id, your timer settings and any card artwork you upload; nothing else.</p>
              <button
                onClick={handleSignOut}
                disabled={busy === 'signout'}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20 disabled:opacity-60"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
