import React, { useState, useSyncExternalStore } from 'react'
import { Users, Check } from 'lucide-react'
import { loadClub, activateClub, leaveClub, subscribeClub } from '@toastmaster-timer/shared'
import { useEntitlement } from '../hooks/useEntitlement'
import { useFlag } from '../hooks/useFlag'
import { trackEvent } from '../utils/posthog'

/**
 * Joining a club, and seeing the one this browser already joined.
 *
 * Shared by /account and /pro/<code>, which are the same transaction reached
 * two ways: the officer's link carries the code, and the account page is where
 * a timer types it. Both end on the same confirmation, so a person who followed
 * a link and a person who typed see the product say the same thing.
 */

/** Every rejection looks the same on the server, so there is one line to show. */
const CLUB_ERRORS = {
  network: 'Could not reach the server. Check your connection and try again.',
  too_many_attempts: 'Too many tries. Wait a minute, then try again.',
}
const CLUB_ERROR_FALLBACK = "That code isn't active. Check with your club officer."

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

  const handleActivate = async (event) => {
    event?.preventDefault?.()
    if (busy || !code.trim()) return
    setBusy(true)
    setError(null)

    // No bearer on the web: the session, if there is one, travels as a cookie.
    const result = await activateClub(code)
    setBusy(false)

    if (!result.ok) {
      setError(CLUB_ERRORS[result.error] || CLUB_ERROR_FALLBACK)
      trackEvent('club_code_rejected', { surface: 'web', source, reason: result.error })
      return
    }

    setCode('')
    trackEvent('club_code_activated', {
      surface: 'web',
      source,
      club_id: result.club.club?.id ?? null,
      is_guest: !identified,
      via: 'typed',
    })
    onActivated?.(result.club)
  }

  const handleLeave = () => {
    const clubId = club?.club?.id ?? null
    leaveClub()
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
        <p className="mt-2 text-gray-300">This browser is on Pro through your club.</p>
        <ul className="mt-4 space-y-1.5 text-gray-200">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your club&apos;s shared timing presets</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your club&apos;s branding on cards and reports</li>
          {identified && (
            <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your own settings and artwork follow you between devices</li>
          )}
        </ul>
        {entitlement.source === 'club' && (
          <p className="mt-4 text-sm text-gray-400">
            Timing in Zoom too? Open the timer there, tap <span className="font-medium">Upgrade</span> and
            enter the same code.
          </p>
        )}
        {/* A deletion, not a restore: this browser's own presets and artwork
            were never written over, so leaving cannot take them away. */}
        <button
          onClick={handleLeave}
          className="mt-4 text-xs text-gray-400 hover:text-gray-200"
        >
          Leave this club on this device
        </button>
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
        Enter the code your club officer shared. No sign-in needed.
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
    </form>
  )
}
