import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Users } from 'lucide-react'
import { trackEvent } from '../utils/posthog'
import { useFlag } from '../hooks/useFlag'
import NotFoundView from '../components/NotFoundView'

/**
 * /club/manage?t=<token> — the page a mailed admin link lands on.
 *
 * It exists rather than the Worker simply redirecting because the token is
 * worth exactly one use: an email client or a security appliance that prefetches
 * links would spend it before the officer ever clicked, and a prefetch is a GET.
 * So the link lands here and this page spends the token with a POST.
 *
 * The Worker still answers a plain GET on /api/club/manage with a redirect, so
 * a pasted API URL works — this page just makes the mailed one safe.
 *
 * Behind the `clubs` release flag, like the console it opens. The token is not
 * spent until the flags have landed, and while clubs is off the page is the
 * not-found view and spends nothing.
 */

const ERRORS = {
  expired: 'That link has expired. Links work for 15 minutes; ask for a fresh one.',
  invalid_link: 'That link has already been used, or it was never ours. Ask for a fresh one.',
  network: 'Could not reach the server. Check your connection and try again.',
}

export default function ClubMagicLink() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('t')
  const queryError = params.get('error')
  const { enabled: clubsEnabled, known: flagsKnown } = useFlag('clubs')
  const clubsReleased = flagsKnown && clubsEnabled
  const [error, setError] = useState(queryError ? ERRORS[queryError] || ERRORS.invalid_link : null)
  // Spending a token is a write, and React 18's StrictMode double-invokes
  // effects in development — the second call would always report "already used".
  const startedRef = useRef(false)

  useEffect(() => {
    if (!clubsReleased || !token || startedRef.current) return
    startedRef.current = true

    fetch(`/api/club/manage?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          setError(ERRORS[body?.error] || ERRORS.invalid_link)
          return
        }
        trackEvent('club_admin_link_used', { surface: 'web', club_id: body?.club?.id ?? null })
        navigate('/club/admin', { replace: true })
      })
      .catch(() => setError(ERRORS.network))
  }, [clubsReleased, token, navigate])

  if (flagsKnown && !clubsEnabled) return <NotFoundView />

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
          {error && clubsReleased ? (
            <>
              <h2 className="text-2xl font-bold">That link didn&apos;t work</h2>
              <p className="mt-3 text-gray-300" role="alert">{error}</p>
              <Link
                to="/club/admin"
                className="mt-6 inline-flex rounded-lg bg-white/10 px-4 py-2 font-medium text-white no-underline hover:bg-white/20"
              >
                Ask for a new link
              </Link>
            </>
          ) : (
            <div className="flex items-center gap-3 text-gray-300">
              <Users className="h-6 w-6 text-amber-300" />
              <p>Opening your club&apos;s console…</p>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
