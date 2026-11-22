import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'
import App from './App.jsx'
import './index.css'
import { initPostHog, trackEvent } from './utils/posthog.js'
import { startWebSession } from './utils/webIdentity.js'
import { warmClubLogo, drainOutbox, setArchiveReporter, startClubCardSync } from '@toastmaster-timer/shared'

// Club Pro belongs to a Zoom account (#167), so nothing club-shaped is applied
// or fetched before /api/me says whose browser this is: startWebSession does
// it then.

// Render first with uninitialized posthog (all trackEvent calls already check __loaded)
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PostHogProvider client={posthog}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PostHogProvider>
  </React.StrictMode>,
)

// Init PostHog when browser is idle
const deferInit = window.requestIdleCallback || ((cb) => setTimeout(cb, 1))
deferInit(() => { initPostHog() })

// Then find out whether this browser is signed in (Sign in with Zoom) and, if
// so, tie analytics to the person, bring the club in line with the account and
// start settings sync. Never awaited: the timer renders and works regardless.
deferInit(() => {
  startWebSession()
    .catch((error) => {
      console.warn('Failed to start web session:', error)
    })
    // The club's logo, decoded once for the badge and the report header, and
    // its card set, fetched where this browser lacks it, now and whenever the
    // club changes. Both for the club this account is in, never another
    // account's copy. Never awaited; a failure leaves a name-only badge.
    .then(() => {
      warmClubLogo()
      startClubCardSync()
    })
    // Speeches the last session could not hand over — a tab closed mid-meeting,
    // a hall with no wifi. The queue is in localStorage precisely so this works,
    // and it goes out once the club is known for this account.
    .then(() => drainOutbox())
    .catch((error) => {
      console.warn('Failed to send queued speeches to the club:', error)
    })
  // An upload that does not go out is invisible from here — the device keeps
  // its own copy and the timer sees nothing wrong — so it has to report itself.
  setArchiveReporter(trackEvent)
})
