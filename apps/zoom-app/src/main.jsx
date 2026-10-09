import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initializeZoomSdk, preloadBackgroundImages, setOverlayTimingReporter } from './utils/zoomSdk'
import { initCardImages, initProfileSync, syncCardAssets, setEntitlement, subscribeEntitlement, FREE_ENTITLEMENT, setFlags, initClubFromCache, refreshClub, warmClubLogo, drainOutbox, setArchiveReporter } from '@toastmaster-timer/shared'
import { initPostHog, identifyUser, setUserProperties, registerSessionProperties, trackEvent } from './utils/posthog'
import { resolveZoomIdentity, getSessionToken } from './utils/zoomIdentity'
import posthog from 'posthog-js'
import { PostHogProvider } from '@posthog/react'

// The one thing that runs before the first paint. A device that joined a club
// is Pro, and reading that out of localStorage — synchronously, costing nothing
// — is what stops the Footer flashing "Upgrade" at a club member while the
// session response is still in flight. That flash is the exact thing the
// entitlement store's `known` flag exists to prevent.
initClubFromCache();

// Render immediately — don't block on SDK init
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  </React.StrictMode>,
)

// Initialize SDK and defer non-critical work in background. Custom card
// images load in parallel with the SDK handshake; pre-decode waits for both
// so it caches the cards that will actually be pushed.
const sdkReady = initializeZoomSdk().catch(() => {
  console.log('Continuing without Zoom SDK (local development mode)');
});
Promise.all([sdkReady, initCardImages()]).then(() => preloadBackgroundImages()).catch((error) => {
  console.warn('Failed to pre-load background images:', error);
});

// The club's logo, decoded once here rather than inside the compositor. Card
// switching is held to a 25 ms warm budget, and an image decode in that path
// would not fit in it. Never awaited, and a failure leaves a name-only badge —
// which is the same badge a club without a logo gets.
warmClubLogo();

try {
  initPostHog();
} catch (error) {
  console.warn('Failed to initialize PostHog:', error);
}

// Re-check the club, at most once a day. A network failure leaves the cache in
// place and the device stays Pro, so a lapse can only land on a successful
// refresh at app start — never in the middle of a meeting.
refreshClub({ getToken: getSessionToken }).catch((error) => {
  console.warn('Failed to refresh the club:', error);
});

// An upload that does not go out is invisible from here — the device keeps its
// own copy and the timer sees nothing wrong — so it has to report itself.
setArchiveReporter(trackEvent);

// How long each threshold color change took to reach the video. Only visible
// from inside the overlay queue, and on a slow machine it is the whole story.
setOverlayTimingReporter(trackEvent);

// Speeches the last session could not hand over — a webview reload mid-meeting
// is routine here, which is exactly why the queue lives in localStorage.
drainOutbox({ getToken: getSessionToken }).catch((error) => {
  console.warn('Failed to send queued speeches to the club:', error);
});

// Tie this session to the Zoom user, so a returning organizer is the same
// person to us next week instead of a brand-new anonymous ID. Deliberately not
// awaited: rendering and the SDK handshake must not wait on analytics.
resolveZoomIdentity()
  .then(({ identified, isGuest, uid, authStatus, role, contextType, meetingId, entitlement, flags }) => {
    // The server's answer on what this user may use. Guests and anonymous
    // loads are free; saying so now stops the UI from guessing.
    setEntitlement(entitlement ?? FREE_ENTITLEMENT);
    // And on which unreleased features to show, in the same breath, so a
    // flag-gated control and an entitlement-gated one appear together. Held
    // for the whole session; nothing re-asks.
    setFlags(flags);

    // The zoom: prefix keeps the ID out of PostHog's anonymous namespace —
    // identifying with a value that was once an anonymous distinct_id is the
    // one thing it asks you not to do.
    if (identified && uid) identifyUser(`zoom:${uid}`);
    setUserProperties({
      surface: 'zoom',
      zoom_identified: identified,
      is_zoom_guest: isGuest,
      ...(authStatus ? { zoom_auth_status: authStatus } : {}),
      // Last-seen role and surface: tells an organizer (host) apart from a
      // participant who opened the app, and in-meeting use from prep in the
      // side panel. Both are inputs to what the paid tier should gate.
      ...(role ? { zoom_role: role } : {}),
      ...(contextType ? { zoom_context_type: contextType } : {}),
    });
    // Per-session facts ride on every event instead: meetings per user is a
    // count over events, not a property of the person.
    registerSessionProperties({
      ...(meetingId ? { zoom_meeting_id: meetingId } : {}),
      ...(contextType ? { zoom_context_type: contextType } : {}),
      ...(role ? { zoom_role: role } : {}),
    });

    // Settings follow the user to whatever machine they run the meeting from.
    // Only meaningful once we know who they are; a guest keeps working entirely
    // from this device's own storage.
    if (!identified) return null;

    // A 402 from either endpoint is the server saying "free plan": record it so
    // the upgrade path appears, and stop pushing until the plan changes.
    const onUpgradeRequired = (fresh) => setEntitlement(fresh ?? FREE_ENTITLEMENT);
    const startSync = () =>
      // Profile first: the hash map arrives with it, and that map is what says
      // which artwork this device ought to be holding.
      initProfileSync({ getToken: getSessionToken, onUpgradeRequired }).then(() =>
        syncCardAssets({ getToken: getSessionToken, onUpgradeRequired })
      );

    // After a purchase the plan flips to pro while the app is open; start the
    // sync again so what this device holds reaches the server right away.
    let wasPro = entitlement?.plan === 'pro';
    subscribeEntitlement((next) => {
      const nowPro = next.plan === 'pro';
      if (nowPro && !wasPro) startSync().catch(() => {});
      wasPro = nowPro;
    });

    return startSync();
  })
  .catch((error) => {
    console.warn('Failed to resolve Zoom identity:', error);
  });
