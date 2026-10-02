import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'
import App from './App.jsx'
import './index.css'
import { initPostHog, trackEvent } from './utils/posthog.js'
import { startWebSession } from './utils/webIdentity.js'
import { initClubFromCache, refreshClub, warmClubLogo, drainOutbox, setArchiveReporter } from '@toastmaster-timer/shared'

// Before the first paint, and synchronous: a browser that joined a club is Pro,
// and reading that out of localStorage now is what stops the plan flashing
// "free" while /api/me is still in flight.
initClubFromCache()
// The club's logo, decoded once so the badge and the report header have it on
// first paint. Never awaited; a failure leaves a name-only badge.
warmClubLogo()

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
// so, tie analytics to the person and start settings sync. Never awaited:
// the timer renders and works regardless.
deferInit(() => {
  startWebSession().catch((error) => {
    console.warn('Failed to start web session:', error)
  })
  // Re-check the club, at most once a day. A failed refresh leaves the cache in
  // place, so a lapse can only land on a successful one.
  refreshClub().catch((error) => {
    console.warn('Failed to refresh the club:', error)
  })
  // An upload that does not go out is invisible from here — the device keeps
  // its own copy and the timer sees nothing wrong — so it has to report itself.
  setArchiveReporter(trackEvent)
  // Speeches the last session could not hand over — a tab closed mid-meeting,
  // a hall with no wifi. The queue is in localStorage precisely so this works.
  drainOutbox().catch((error) => {
    console.warn('Failed to send queued speeches to the club:', error)
  })
})
