import { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import { ZOOM_INSTALL_URL, ZOOM_RECONNECT_HELP_URL, TIMER_APP_URL } from '@toastmaster-timer/shared';
import { initializeZoomSdk, openExternalUrl } from '../utils/zoomSdk';
import {
  CONNECTION_CONNECTED,
  CONNECTION_REVOKED,
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

  useEffect(() => {
    let cancelled = false;

    initializeZoomSdk()
      .catch(() => false)
      .then((sdkReady) => {
        if (cancelled) return;

        const launch = readLaunchContext();
        const resolved = resolveConnectionState({
          sdkReady: Boolean(sdkReady),
          launch,
          isDev: import.meta.env.DEV,
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

    return () => {
      cancelled = true;
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

  const reAdd = () => handOff(INSTALL_URL, 'zoom_reconnect_clicked', { returning_user: returning });
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
