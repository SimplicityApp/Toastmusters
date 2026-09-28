import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Sparkles, Check, ExternalLink, LogOut } from 'lucide-react'
import { refreshEntitlement, createClub } from '@toastmaster-timer/shared'
import ClubSetupCard from '@toastmaster-timer/ui/ClubSetupCard'
import { useEntitlement, useWebIdentity } from '../hooks/useEntitlement'
import { useClub } from '../hooks/useClub'
import { signInUrl, signOut } from '../utils/webIdentity'
import { signinFailureMessage } from '../utils/signinFailure'
import { trackEvent } from '../utils/posthog'
import ClubCodeSection from '../components/ClubCodeSection'

/**
 * The signed-in user's plan, and the way to buy or manage it from the web.
 *
 * On the web Checkout can simply navigate: Stripe sends the browser back to
 * /billing/success, and the next load of this page asks the Worker again.
 */

/** Why setting up a club was refused, in the officer's words. */
const CLUB_CREATE_ERRORS = {
  not_a_subscriber: 'Only the person who pays for the plan can set up the club.',
  no_billing_account:
    'We cannot find your payment yet. If you have just subscribed, give it a minute and try again.',
  creation_in_progress: 'Your club is already being set up. Give it a moment, then reload.',
  network: 'Could not reach the server. Check your connection and try again.',
}
const CLUB_CREATE_FALLBACK = 'Could not set up your club. Please try again.'

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

export default function Account() {
  const identity = useWebIdentity()
  const { entitlement, isPro, known } = useEntitlement()
  const { club } = useClub()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  // What the buyer calls their club. Optional, and never a gate on checkout.
  const [clubName, setClubName] = useState('')
  const [clubBusy, setClubBusy] = useState(false)
  const [clubError, setClubError] = useState(null)
  // What the create call just handed back. Held separately from the cache so
  // the code is on screen the instant it exists, not one refresh later.
  const [minted, setMinted] = useState(null)

  // Gated on admin-of-a-club rather than on this-device-has-a-club: a
  // subscriber who joined someone else's club with a code is still someone who
  // may want their own, and the server would let them.
  const isClubAdmin = club?.role === 'admin'
  const canCreateClub = isPro && entitlement.source === 'subscription' && !isClubAdmin
  const shareCode = minted?.code ?? (isClubAdmin ? club?.code ?? null : null)
  const shareUrl = minted?.shareUrl ?? (isClubAdmin ? club?.shareUrl ?? null : null)

  const handleCreateClub = async (name) => {
    setClubBusy(true)
    setClubError(null)
    const result = await createClub({ clubName: name })
    setClubBusy(false)

    if (!result.ok) {
      setClubError(CLUB_CREATE_ERRORS[result.error] || CLUB_CREATE_FALLBACK)
      trackEvent('club_create_failed', { surface: 'web', source: 'self_serve', reason: result.error })
      return
    }

    setMinted({ code: result.code, shareUrl: result.shareUrl })
    trackEvent('club_created', {
      surface: 'web',
      source: 'self_serve',
      club_id: result.club.club?.id ?? null,
      // False means the button was pressed twice, or the webhook got there
      // first — worth telling apart from a club this click actually made.
      created: result.created,
    })
  }

  const signinFailure = signinFailureMessage(searchParams)

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
    trackEvent('checkout_started', { source: 'web_account', interval, named_club: Boolean(clubName.trim()) })
    // An empty name never blocks the purchase: the club is minted with a
    // generated placeholder and renaming is a one-field edit, whereas a buyer
    // stopped at a required field is a sale lost.
    const { ok, body } = await postJson('/api/billing/checkout', {
      interval,
      ...(clubName.trim() ? { clubName: clubName.trim() } : {}),
    })
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
            {entitlement.source === 'club'
              ? 'Through your club.'
              : entitlement.source === 'grant'
              ? 'Complimentary access.'
              : entitlement.cancelAtPeriodEnd && entitlement.currentPeriodEnd
                ? `Ends on ${new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.`
                : entitlement.currentPeriodEnd
                  ? `Renews on ${new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.`
                  : 'Active.'}
            {' '}Your settings and card artwork follow you between the web and Zoom.
          </p>
          {/* A club member never bought anything here, so there is no portal
              to open — the club's billing belongs to whoever paid. */}
          {entitlement.source !== 'grant' && entitlement.source !== 'club' && (
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
        {/* One Pro account for the whole club: the club's own lines come first,
            because the person paying is rarely the person timing. */}
        <ul className="mt-4 space-y-1.5 text-gray-200">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Pro: your club&apos;s brand kit on every timer card and report</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Pro: shared timing presets — set once, every timer gets them</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Pro: every meeting saved to your club&apos;s archive</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Pro: your settings and card artwork synced across devices</li>
        </ul>
        {entitlement.status && entitlement.currentPeriodEnd && (
          <p className="mt-3 text-sm text-gray-400">Your previous plan ended on {new Date(entitlement.currentPeriodEnd).toLocaleDateString()}.</p>
        )}
        <label htmlFor="checkout-club-name" className="mt-5 block text-sm font-medium text-gray-200">
          Your club&apos;s name <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <input
          id="checkout-club-name"
          value={clubName}
          onChange={(event) => setClubName(event.target.value)}
          placeholder="Downtown Speakers"
          maxLength={80}
          className="mt-1 w-full rounded-md border border-white/20 bg-black/30 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-4 grid grid-cols-2 gap-3">
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

        <section className="mt-6 rounded-2xl border border-white/10 bg-black/30 px-6 py-6">
          <h3 className="text-sm uppercase tracking-wide text-gray-400">Your club</h3>
          {/* Ahead of the code field: a subscriber with no club has nothing to
              type, and the code field alone was the whole dead end. */}
          {(shareCode || canCreateClub) && (
            <div className="mt-3 border-b border-white/10 pb-6">
              <ClubSetupCard
                tone="dark"
                code={shareCode}
                shareUrl={shareUrl}
                busy={clubBusy}
                error={clubError}
                onCreate={handleCreateClub}
                onCopied={(what) => trackEvent('club_invite_copied', { surface: 'web', what })}
                onManageClub={() => navigate('/club/admin')}
              />
            </div>
          )}
          <div className="mt-4">
            <ClubCodeSection source="web_account" identified={Boolean(identity?.identified)} />
          </div>
        </section>

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
