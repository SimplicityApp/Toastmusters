import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initializeZoomSdk, preloadBackgroundImages } from './utils/zoomSdk'
import { initCardImages, initProfileSync, syncCardAssets } from '@toastmaster-timer/shared'
import { initPostHog, identifyUser, setUserProperties } from './utils/posthog'
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
  .then(({ identified, isGuest, uid, authStatus }) => {
    // The zoom: prefix keeps the ID out of PostHog's anonymous namespace —
    // identifying with a value that was once an anonymous distinct_id is the
    // one thing it asks you not to do.
    if (identified && uid) identifyUser(`zoom:${uid}`);
    setUserProperties({
      surface: 'zoom',
      zoom_identified: identified,
      is_zoom_guest: isGuest,
      ...(authStatus ? { zoom_auth_status: authStatus } : {}),
    });

    // Settings follow the user to whatever machine they run the meeting from.
    // Only meaningful once we know who they are; a guest keeps working entirely
    // from this device's own storage.
    if (!identified) return null;

    // Profile first: the hash map arrives with it, and that map is what says
    // which artwork this device ought to be holding.
    return initProfileSync({ getToken: getSessionToken }).then(() =>
      syncCardAssets({ getToken: getSessionToken })
    );
  })
  .catch((error) => {
    console.warn('Failed to resolve Zoom identity:', error);
  });
