import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { ZOOM_INSTALL_URL, ZOOM_RECONNECT_HELP_URL, TIMER_APP_URL } from '@toastmaster-timer/shared';
import {
  initializeZoomSdk,
  openExternalUrl,
  promptZoomAuthorize,
  readZoomUserStatus,
  setUserStatusChangeCallback,
} from '../utils/zoomSdk';
import {
  CONNECTION_CONNECTED,
  CONNECTION_REVOKED,
  CONNECTION_UNAUTHORIZED,
  STATUS_AUTHORIZED,
  isReturningUser,
  needsAttention,
  readLaunchContext,
  resolveConnectionState,
} from '../utils/zoomConnection';
import { trackEvent } from '../utils/posthog';
import { useToast } from '../context/ToastContext';

// The marketing site builds its "Add to Zoom" href from this env var, so honour
// it here too — a deployment that has customised the install link must not end
// up with the in-app reconnect button pointing somewhere else. The shared
// constant is the fallback, and the only value the Zoom app build has today.
const INSTALL_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT || ZOOM_INSTALL_URL;

// The modal is the loud half; once per app session is enough. The banner below
// it stays for as long as the problem does.
const MODAL_SEEN_KEY = 'toastmaster_reconnect_modal_seen';

function readModalSeen() {
  try {
    return sessionStorage.getItem(MODAL_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markModalSeen() {
  try {
    sessionStorage.setItem(MODAL_SEEN_KEY, '1');
  } catch {
    // Session storage is a nicety here; losing it only re-shows the modal.
  }
}

/**
 * What to say, given how we lost Zoom and whether this organizer has used the
 * app before. Returning users get the reassurance that matters most to them —
 * their agendas and reports are origin-scoped browser storage and survive a
 * reinstall untouched — and the cause, so a silent failure stops reading as a
 * broken app. Exported for testing.
 */
export function noticeCopy(state, returning) {
  // Guest mode has its own copy whether or not they have used the app before:
  // the symptom is the same permission dialog on every color change, and the
  // fix is one click inside Zoom rather than a trip to the browser.
  if (state === CONNECTION_UNAUTHORIZED) {
    return {
      bannerText: 'Zoom asks permission on every color change until you approve this app.',
      title: 'Approve Toastmusters Timer in Zoom',
      body:
        'Zoom is treating this app as a guest, which usually happens after an app update ' +
        'changes what it asks for. Until you approve it again, Zoom will pop up an "Allow" ' +
        'dialog every time the timer changes your background. Approving takes one click and ' +
        (returning ? 'leaves your agendas, roles and reports exactly where they are.' : 'the timer then runs without interruptions.'),
      cta: 'Approve in Zoom',
    };
  }

  if (!returning) {
    return {
      bannerText: 'Add Toastmusters Timer to Zoom to control your video during meetings.',
      title: 'Add Toastmusters Timer to Zoom',
      body:
        'Once added, the timer runs inside your Zoom meetings and turns your video green, ' +
        'yellow and red as each speaker’s time passes.',
      cta: 'Add to Zoom',
    };
  }

  if (state === CONNECTION_REVOKED) {
    return {
      bannerText: 'Zoom removed this app’s access — re-add it to control your video again.',
      title: 'Zoom removed this app’s access',
      body:
        'Toastmusters Timer can no longer change your video, which usually means Zoom dropped ' +
        'its permission after an app update or a change by your Zoom admin. Your agendas, ' +
        'roles and reports are safe on this device — re-adding takes about ten seconds and ' +
        'leaves them untouched.',
      cta: 'Re-add to Zoom',
    };
  }

  return {
    bannerText: 'Not connected to Zoom — re-add the app to control your video again.',
    title: 'Not connected to Zoom',
    body:
      'This page isn’t running inside the Zoom client, so the timer can’t change your video. ' +
      'If Zoom just sent you here, the app’s access needs renewing — re-add it and it will ' +
      'open in your meetings again. Your agendas, roles and reports are safe on this device.',
    cta: 'Re-add to Zoom',
  };
}

/**
 * Tells the organizer when the app has lost its grip on Zoom, and hands them
 * the one fix. Renders nothing while the handshake is in flight, when it
 * succeeded, and in local development.
 *
 * Deliberately not a gate: in this state the timer still counts, still records
 * the report and still drives a shared-screen stage, so blocking the UI would
 * cost a meeting already in progress more than the missing backgrounds do.
 */
export default function ZoomConnectionNotice() {
  const [state, setState] = useState(CONNECTION_CONNECTED);
  const [returning, setReturning] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const { showToast } = useToast();
  // The status callback below is registered once and outlives every render, so
  // it reads the current state through a ref rather than a stale closure.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;

    initializeZoomSdk()
      .catch(() => false)
      .then(async (sdkReady) => {
        // Only a client that shook hands can say how the user stands with it;
        // asking a refused SDK would just be a second failure to read.
        const authStatus = sdkReady ? await readZoomUserStatus().catch(() => null) : null;
        if (cancelled) return;

        const launch = readLaunchContext();
        const resolved = resolveConnectionState({
          sdkReady: Boolean(sdkReady),
          launch,
          isDev: import.meta.env.DEV,
          authStatus,
        });
        if (!needsAttention(resolved)) return;

        const hasHistory = isReturningUser();
        setState(resolved);
        setReturning(hasHistory);
        setModalOpen(!readModalSeen());

        // Nothing measures how often Zoom drops an install today: the
        // deauthorize webhook only sees admin-initiated removals, never a
        // token that simply stopped working.
        trackEvent('zoom_connection_degraded', {
          connection_state: resolved,
          launch_context: launch,
          returning_user: hasHistory,
        });
      });

    // The in-client approval flow reports back through the SDK, not through
    // the button's promise: stand the notice down the moment Zoom says the
    // user is authorized again, and say so, since the dialog they clicked
    // through gave them no other confirmation that the popups will stop.
    // Only while the notice is up: the same event fires on a role change
    // (host to co-host), where an already-authorized user has nothing to hear.
    setUserStatusChangeCallback((status) => {
      if (cancelled || status !== STATUS_AUTHORIZED) return;
      if (stateRef.current !== CONNECTION_UNAUTHORIZED) return;
      setState(CONNECTION_CONNECTED);
      setModalOpen(false);
      trackEvent('zoom_reauthorized');
      showToast('Approved. Zoom will stop asking permission for background changes.', 'success', 5000);
    });

    return () => {
      cancelled = true;
      setUserStatusChangeCallback(null);
    };
  }, []);

  const copy = noticeCopy(state, returning);

  const closeModal = () => {
    markModalSeen();
    setModalOpen(false);
  };

  const handOff = async (url, event, properties = {}) => {
    trackEvent(event, { connection_state: state, ...properties });

    // The Zoom webview ignores target="_blank", so links have to go through the
    // SDK. When that hand-off fails there is no browser tab and no error the
    // user would otherwise see, so say so rather than leaving a dead button.
    if (!(await openExternalUrl(url))) {
      showToast('Could not open the browser. Search "Toastmasters Timer" in the Zoom App Marketplace.', 'error', 6000);
      return;
    }
    closeModal();
  };

  /**
   * Guest mode's fix is inside the client: Zoom's own add-the-app prompt, no
   * browser involved. The install URL stays as the fallback for a client that
   * refused promptAuthorize, where the browser flow still restores the grant.
   */
  const approveInZoom = async () => {
    trackEvent('zoom_reauthorize_clicked', { connection_state: state, returning_user: returning });
    if (await promptZoomAuthorize()) {
      closeModal();
      return;
    }
    await handOff(INSTALL_URL, 'zoom_reconnect_clicked', { returning_user: returning, fallback: true });
  };

  const reAdd = () =>
    state === CONNECTION_UNAUTHORIZED
      ? approveInZoom()
      : handOff(INSTALL_URL, 'zoom_reconnect_clicked', { returning_user: returning });
  const browserTimer = () => handOff(TIMER_APP_URL, 'browser_timer_fallback_clicked');
  const why = () => handOff(ZOOM_RECONNECT_HELP_URL, 'zoom_reconnect_help_clicked');

  if (!needsAttention(state)) return null;

  return (
    <>
      <div
        role="status"
        className="w-full flex items-center gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-900"
      >
        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-600" aria-hidden />
        <span className="text-xs leading-snug flex-1">{copy.bannerText}</span>
        {/* The modal has already explained itself once by the time this is the
            only thing left on screen, so the banner does what its label says
            rather than re-opening the explanation. */}
        <button
          onClick={reAdd}
          className="flex-shrink-0 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold transition-colors"
        >
          {copy.cta}
        </button>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="zoom-connection-title"
            className="bg-white rounded-lg p-6 w-full max-w-md"
          >
            <div className="flex justify-between items-start mb-4">
              <h3 id="zoom-connection-title" className="text-lg font-semibold">{copy.title}</h3>
              <button
                onClick={closeModal}
                className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-5">{copy.body}</p>

            <div className="flex flex-col gap-2">
              <button
                onClick={reAdd}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm"
              >
                <ExternalLink className="w-4 h-4" />
                {copy.cta}
              </button>
              <button
                onClick={browserTimer}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
              >
                Use the browser timer instead
              </button>
            </div>

            {returning && (
              <button
                onClick={why}
                className="mt-3 w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Why did this happen?
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
