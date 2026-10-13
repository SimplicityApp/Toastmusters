import { Link } from 'react-router-dom'
import { ZOOM_MARKETPLACE_LISTING_URL, zoomAppDeeplink } from '@toastmaster-timer/shared'
import { trackEvent } from '../utils/posthog'

/**
 * The reconnect page (GitHub issue #96).
 *
 * When a user's Zoom approval lapses (an app update that changes its scopes,
 * for one), clicking the app in Zoom opens our website instead of the timer.
 * This page tells them why, that their data is safe, and offers the one thing
 * that fixes it: approving the app in Zoom again.
 *
 * The site cannot tell a lapsed user from a healthy one, so every line here has
 * to be true for anyone who reads it. Visitors who did not need to reconnect
 * get quiet ways out: open the app, or go to the homepage.
 *
 * Reached two ways. A browser that has added the app from our site before is
 * sent here by the Worker when it opens a bare / (worker/reconnect.js), which
 * is where Zoom drops a user whose approval lapsed. Anyone else can follow the
 * homepage's "Already use the Zoom app? Reconnect it" line.
 * Same light look as the homepage, so it reads as part of the same site.
 */

// Landing.jsx's primary pill, so "Approve in Zoom" looks like the homepage's
// "Add to Zoom" it stands in for.
const BTN_PRIMARY = 'inline-flex items-center justify-center rounded-full bg-ink px-7 py-3 text-base font-semibold text-white hover:bg-stone-700 transition-colors'
const LINK = 'underline underline-offset-4 decoration-stone-300 hover:text-ink hover:decoration-ink transition-colors'

// The homepage's click event, with this page's path. `cta` is what the click
// does: approve_in_zoom, web_timer, open_in_zoom or home.
const trackCta = (cta) => () => trackEvent('cta_clicked', { cta, location: 'hero', page: '/reconnect' })

const REASSURANCES = [
  { title: 'Your agendas, roles and reports are safe.', body: 'Approving does not touch them.' },
  { title: 'It takes about ten seconds.', body: "One click here, one on Zoom's approval screen." },
  { title: 'Then go back to your meeting.', body: "We'll show you the way once you're done." },
]

export default function Reconnect() {
  // The same links as the homepage, from the build: a dev build approves and
  // opens the dev Zoom app. Read at render time so tests can set the variable.
  const ADD_TO_ZOOM_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT || ZOOM_MARKETPLACE_LISTING_URL
  const ZOOM_APP_URL = zoomAppDeeplink(import.meta.env.VITE_ZOOM_OAUTH_REDIRECT)

  return (
    <div className="min-h-screen bg-cream text-ink">
      <header className="bg-cream/85 backdrop-blur-md border-b border-stone-200/80">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2.5">
          <img
            src="/Toastmasters-Timer-logo.jpg"
            alt="Toastmusters Timer app logo"
            className="h-9 w-9 rounded-xl object-cover"
          />
          <span className="font-display text-lg font-bold">Toastmusters Timer</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 pt-12 sm:pt-14 pb-12 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-stone-600">
          <span className="inline-flex gap-1" aria-hidden>
            <span className="h-2 w-2 rounded-full bg-timer-green" />
            <span className="h-2 w-2 rounded-full bg-timer-yellow" />
            <span className="h-2 w-2 rounded-full bg-timer-red" />
          </span>
          Welcome back
        </p>

        <h1 className="mt-6 font-display text-3xl sm:text-[2.375rem] font-extrabold tracking-tight leading-[1.12]">
          Reconnect Toastmusters Timer to Zoom
        </h1>
        <p className="mt-4 text-lg text-stone-600 leading-relaxed">
          If Zoom asked you to approve the app again, you&apos;re in the right place. We updated the
          app, and Zoom needs your OK before the timer can control your video. Nothing is broken.
        </p>

        <ul className="mt-7 rounded-3xl border border-stone-200 bg-white px-6 py-5 text-left shadow-sm">
          {REASSURANCES.map((item) => (
            <li key={item.title} className="flex gap-2.5 py-1.5 text-[15px] leading-normal text-stone-700">
              <span className="font-bold text-green-600" aria-hidden>✓</span>
              <span>
                <strong className="font-semibold text-ink">{item.title}</strong> {item.body}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-7 flex flex-col items-center gap-3.5">
          {/* Same tab on purpose: Zoom's approval screen comes back to the
              "You're reconnected" page, so the user ends up in one tab with
              no stale reconnect page left behind. */}
          <a href={ADD_TO_ZOOM_URL} onClick={trackCta('approve_in_zoom')} className={BTN_PRIMARY}>
            Approve in Zoom
          </a>
          <Link to="/timer/app" onClick={trackCta('web_timer')} className={`text-sm text-stone-600 ${LINK}`}>
            Use the browser timer instead
          </Link>
          <p className="mt-1 border-t border-stone-200 pt-3 text-[13px] text-stone-500">
            <a href={ZOOM_APP_URL} onClick={trackCta('open_in_zoom')} className={LINK}>
              Already approved? Open in Zoom
            </a>
            <span aria-hidden>{' · '}</span>
            {/* /?home, not /. The design sends a returning browser's bare /
                to this page (#96); a query string always reaches the
                homepage, and keeps it there on a reload. */}
            <Link to="/?home" onClick={trackCta('home')} className={LINK}>
              Go to the homepage
            </Link>
          </p>
        </div>

        <p className="mt-9 text-[13px] text-stone-500 leading-normal">
          Why am I seeing this? Zoom asks you to approve an app again when the permissions it needs
          change. You only do this once per update.
        </p>
      </main>
    </div>
  )
}
