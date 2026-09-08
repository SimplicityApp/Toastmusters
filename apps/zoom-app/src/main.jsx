import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initializeZoomSdk, preloadBackgroundImages } from './utils/zoomSdk'
import { initCardImages, initProfileSync, syncCardAssets, setEntitlement, subscribeEntitlement, FREE_ENTITLEMENT } from '@toastmaster-timer/shared'
import { initPostHog, identifyUser, setUserProperties, registerSessionProperties } from './utils/posthog'
import { resolveZoomIdentity, getSessionToken } from './utils/zoomIdentity'
import posthog from 'posthog-js'
import { PostHogProvider } from '@posthog/react'

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

try {
  initPostHog();
} catch (error) {
  console.warn('Failed to initialize PostHog:', error);
}

// Tie this session to the Zoom user, so a returning organizer is the same
// person to us next week instead of a brand-new anonymous ID. Deliberately not
// awaited: rendering and the SDK handshake must not wait on analytics.
resolveZoomIdentity()
  .then(({ identified, isGuest, uid, authStatus, role, contextType, meetingId, entitlement }) => {
    // The server's answer on what this user may use. Guests and anonymous
    // loads are free; saying so now stops the UI from guessing.
    setEntitlement(entitlement ?? FREE_ENTITLEMENT);

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
