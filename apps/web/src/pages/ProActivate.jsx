import React, { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Users, Check } from 'lucide-react'
import { activateClub } from '@toastmaster-timer/shared'
import { useWebIdentity } from '../hooks/useEntitlement'
import { useClub } from '../components/ClubCodeSection'
import { trackEvent } from '../utils/posthog'

/**
 * /pro/<code> — the officer's shareable link.
 *
 * It can only ever land in a browser: links open the system browser, never the
 * Zoom sidebar. So this page activates the club here and then tells a timer who
 * times in Zoom exactly where to type the same code, which is the other half of
 * the job — the link is the discoverability mechanism for a field that has no
 * banner and no first-launch prompt pointing at it.
 */

const CLUB_ERRORS = {
  network: 'Could not reach the server. Check your connection and try again.',
  too_many_attempts: 'Too many tries. Wait a minute, then reload this page.',
}
const CLUB_ERROR_FALLBACK = "That code isn't active. Check with your club officer."

export default function ProActivate() {
  const { code } = useParams()
  const identity = useWebIdentity()
  const club = useClub()
  const [phase, setPhase] = useState('activating') // activating | done | error
  const [error, setError] = useState(null)
  // Activation writes a device record, so it must happen once per visit and not
  // once per render — React 18's StrictMode double-invokes effects in dev.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    activateClub(code).then((result) => {
      if (!result.ok) {
        setError(CLUB_ERRORS[result.error] || CLUB_ERROR_FALLBACK)
        setPhase('error')
        trackEvent('club_code_rejected', { surface: 'web', source: 'pro_link', reason: result.error })
        return
      }
      setPhase('done')
      trackEvent('club_code_activated', {
        surface: 'web',
        source: 'pro_link',
        club_id: result.club.club?.id ?? null,
        // Resolved after this fires in the common case; the link is explicitly
        // built for people who are not signed in, so the default is honest.
        is_guest: !identity?.identified,
        via: 'link',
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-white/10 bg-black/25 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-4">
          <Link to="/" className="flex items-center gap-3 text-white no-underline">
            <img src="/Toastmasters-Timer-logo.jpg" alt="Toastmusters Timer" className="h-10 w-10 rounded-xl object-cover shadow-sm ring-1 ring-white/20" />
            <h1 className="text-xl font-semibold">Toastmusters Timer</h1>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-12">
        <section className="rounded-2xl border border-white/10 bg-black/30 px-6 py-8">
          {phase === 'activating' && <p className="text-gray-300">Activating…</p>}

          {phase === 'error' && (
            <>
              <h2 className="text-2xl font-bold">That code didn&apos;t work</h2>
              <p className="mt-3 text-gray-300" role="alert">{error}</p>
              <Link
                to="/account"
                className="mt-6 inline-flex rounded-lg bg-white/10 px-4 py-2 font-medium text-white no-underline hover:bg-white/20"
              >
                Enter a different code
              </Link>
            </>
          )}

          {phase === 'done' && (
            <>
              <div className="flex items-center gap-2 text-amber-300">
                <Users className="h-6 w-6" />
                <span className="text-xl font-semibold">{club?.club?.name || 'Your club'}</span>
              </div>
              <h2 className="mt-3 text-2xl font-bold">You&apos;re on Pro in this browser</h2>
              <ul className="mt-5 space-y-1.5 text-gray-200">
                <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your club&apos;s shared timing presets</li>
                <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-400" /> Your club&apos;s branding on cards and reports</li>
              </ul>

              {/* The other half of the link's job. A Zoom link cannot open the
                  sidebar app, so the code has to be typed there instead. */}
              <div className="mt-6 rounded-xl border border-white/10 bg-white/5 px-4 py-4">
                <p className="font-medium text-white">Time your meetings in Zoom?</p>
                <p className="mt-1 text-sm text-gray-300">
                  Open Toastmusters Timer in Zoom, tap <span className="font-medium">Upgrade</span>, and enter
                  this code:
                </p>
                <p className="mt-2 font-mono text-lg tracking-widest text-amber-300">{code?.toUpperCase()}</p>
              </div>

              <Link
                to="/app"
                className="mt-6 inline-flex rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white no-underline hover:bg-blue-600"
              >
                Open the timer
              </Link>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
