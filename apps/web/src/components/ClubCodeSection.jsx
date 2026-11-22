import React, { useState, useSyncExternalStore } from 'react'
import { Users, Check } from 'lucide-react'
import { loadClub, activateClub, leaveClub, subscribeClub } from '@toastmaster-timer/shared'
import { useEntitlement, useWebIdentity } from '../hooks/useEntitlement'
import { useFlag } from '../hooks/useFlag'
import { resolveWebIdentity, signInUrl } from '../utils/webIdentity'
import { trackEvent } from '../utils/posthog'

/**
 * Joining a club, and seeing the one this account is in.
 *
 * Shared by /account and /pro/<code>, which are the same transaction reached
 * two ways: the officer's link carries the code, and the account page is where
 * a timer types it. Club Pro belongs to a Zoom account (#167), so both need a
 * Zoom sign-in, and a signed-out browser is sent through one that comes back
 * to /pro/<code>.
 */

/**
 * A wrong code, a lapsed club and a blocked account all look the same on the
 * server, so they share one line; the refusals a person can act on name what
 * to do.
 */
const CLUB_ERRORS = {
  network: 'Could not reach the server. Check your connection and try again.',
  too_many_attempts: 'Too many tries. Wait a minute, then try again.',
}
const CLUB_ERROR_FALLBACK = "That code isn't active. Check with your club officer."

/** The line to show for a refused code. */
export function clubErrorFor(result) {
  if (result.error === 'full') {
    return `This club's Pro is full (${result.placesUsed ?? 3} of ${result.placesTotal ?? 3}). Ask the person who shared the code to free a place.`
  }
  if (result.error === 'already_in_club') {
    return `You're already in ${result.clubName || 'another club'}. Leave it to join another club.`
  }
  return CLUB_ERRORS[result.error] || CLUB_ERROR_FALLBACK
}

const leaveCopy = (name) => `Leave ${name}? You'll lose its Pro on every computer where you're signed in.`

/** Why leaving was refused. The owner never sees Leave, but the server says so too. */
const LEAVE_ERRORS = {
  last_admin: 'A club needs at least one admin. Promote somebody else first.',
  owner: 'The club’s owner can’t leave it. To end it, cancel the subscription.',
  network: 'Could not reach the server. Check your connection and try again.',
}
const LEAVE_ERROR_FALLBACK = 'Could not leave the club. Please try again.'

export function useClub() {
  return useSyncExternalStore(subscribeClub, loadClub, () => null)
}

/**
 * @param {{surface?: string, initialCode?: string, autoActivate?: boolean,
 *   identified?: boolean, onActivated?: (club: Object) => void}} props
 */
export default function ClubCodeSection({ source = 'web_account', identified = false, onActivated }) {
  const club = useClub()
  const { entitlement } = useEntitlement()
  // The code field is a door into a club, refused by the Worker while pro is
  // dark. The joined view below is not: a browser already in a club keeps it.
  const { enabled: proEnabled, known: flagsKnown } = useFlag('pro')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Set when a code was entered without a Zoom sign-in behind it.
  const [needsSignIn, setNeedsSignIn] = useState(false)
  // The page's own answer on who this is; the prop is false until it lands.
  const identity = useWebIdentity()
  const signedOut = !identified && identity !== null && !identity.identified
  // Signed out, the code goes to the sign-in rather than the server, and the
  // sign-in comes back to /pro/<code>, which joins.
  const typed = code.trim()
  const signInHref = signInUrl(typed ? `/pro/${encodeURIComponent(typed)}` : '/account')

  const handleActivate = async (event) => {
    event?.preventDefault?.()
    if (busy || !typed) return
    setError(null)

    // Asked again rather than trusted from the prop, which is false until the
    // page's own identity call has answered.
    const who = identified ? null : await resolveWebIdentity()
    if (!identified && !who?.identified) {
      setNeedsSignIn(true)
      trackEvent('club_code_rejected', { surface: 'web', source, reason: 'sign_in_required' })
      return
    }

    setBusy(true)
    setNeedsSignIn(false)
    // No bearer on the web: the session travels as a cookie.
    const result = await activateClub(typed, who?.uid ? { uid: who.uid } : {})
    setBusy(false)

    if (!result.ok) {
      trackEvent('club_code_rejected', { surface: 'web', source, reason: result.error })
      if (result.error === 'sign_in_required') setNeedsSignIn(true)
      else setError(clubErrorFor(result))
      return
    }

    setCode('')
    trackEvent('club_code_activated', {
      surface: 'web',
      source,
      club_id: result.club.club?.id ?? null,
      places_used: result.placesUsed,
      via: 'typed',
    })
    onActivated?.(result.club)
  }

  // By account, on every computer it is signed in on, so it asks first.
  const handleLeave = async () => {
    const clubId = club?.club?.id ?? null
    if (!window.confirm(leaveCopy(club?.club?.name || 'your club'))) return
    const result = await leaveClub()
    if (!result.ok) {
      setError(LEAVE_ERRORS[result.error] || LEAVE_ERROR_FALLBACK)
      return
    }
    setError(null)
    trackEvent('club_left', { surface: 'web', source, club_id: clubId })
  }

  if (club?.entitled) {
    return (
      <>
        <div className="flex items-center gap-2 text-amber-300">
          <Users className="h-5 w-5" />
          <span className="text-lg font-semibold">{club.club?.name || 'Your club'}</span>
        </div>
        <p className="mt-2 text-gray-300">You&apos;re on Pro through {club.club?.name || 'your club'}.</p>
        <ul className="mt-4 space-y-1.5 text-gray-200">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your club&apos;s shared timing presets</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your club&apos;s branding on cards and reports</li>
          {identified && (
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your own settings and artwork follow you between devices</li>
          )}
        </ul>
        {entitlement.source === 'club' && (
          <p className="mt-4 text-sm text-gray-400">
            Timing in Zoom too? Open the timer there with this same Zoom account: your club&apos;s Pro is
            already there.
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
        {/* The owner pays for the club and ends it by cancelling, so they are
            never offered Leave. Nobody's own presets and artwork were written
            over, so leaving cannot take them away. */}
        {!club.isOwner && (
          <button
            onClick={handleLeave}
            className="mt-4 text-xs text-gray-400 hover:text-gray-200"
          >
            Leave {club.club?.name || 'this club'}
          </button>
        )}
      </>
    )
  }

  if (!flagsKnown || !proEnabled) return null

  return (
    <form onSubmit={handleActivate}>
      <label htmlFor="club-code" className="block font-medium text-white">
        Already on Pro through your club?
      </label>
      <p className="mt-1 mb-3 text-sm text-gray-400">
        Enter the code your club officer shared. It joins the Zoom account you&apos;re signed in with.
      </p>
      <div className="flex gap-2">
        <input
          id="club-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="DTSP-7K2QM9"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 rounded-md border border-white/20 bg-black/30 px-3 py-2 uppercase tracking-wide text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="rounded-lg bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/20 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Activate'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
      {(needsSignIn || signedOut) && (
        <a
          href={signInHref}
          className="mt-3 inline-flex rounded-lg bg-blue-500 px-4 py-2 text-sm font-semibold text-white no-underline hover:bg-blue-600"
        >
          Sign in with Zoom to join
        </a>
      )}
    </form>
  )
}
