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
  STATUS_AUTHENTICATED,
  STATUS_AUTHORIZED,
  isReturningUser,
  needsAttention,
  readLaunchContext,
  readInstallUrl,
  resolveConnectionState,
} from '../utils/zoomConnection';
import { trackEvent } from '../utils/posthog';
import { useToast } from '../context/ToastContext';
import { useTimerTick } from '../context/TimerContext';

// The Worker stamps the install link for the Zoom app this deployment belongs
// to (readInstallUrl), and that wins: a build-time value names one app for
// every deployment, which is how the dev host sent guests through the
// production install. Below it, the marketing site's env var, so a deployment
// that customised its "Add to Zoom" href is honoured, then the shared constant.
const INSTALL_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT || ZOOM_INSTALL_URL;
const installUrl = () => readInstallUrl() || INSTALL_URL;

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
  // Until the mount's own read resolves, stateRef holds the placeholder
  // "connected", so a status report racing that read could raise the notice
  // and count the drop a second time. The mount is authoritative for that
  // window; reports arriving before it are ignored.
  const resolvedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    /**
     * Put the notice up. On open and mid-session share this one path, so the
     * copy, the once-per-session modal rule and the analytics cannot drift
     * apart between the two triggers.
     */
    const raise = (resolved, launch, detected) => {
      const hasHistory = isReturningUser();
      // Written ahead of the re-render, so a second report arriving before it
      // sees the notice already up and does not count the drop twice.
      stateRef.current = resolved;
      setState(resolved);
      setReturning(hasHistory);
      setModalOpen(!readModalSeen());

      // Nothing measures how often Zoom drops an install today: the
      // deauthorize webhook only sees admin-initiated removals, never a
      // token that simply stopped working. `detected` separates the drops
      // found at open from those Zoom reported while the panel was up.
      trackEvent('zoom_connection_degraded', {
        connection_state: resolved,
        launch_context: launch,
        returning_user: hasHistory,
        detected,
      });
    };

    // The in-client approval flow reports back through the SDK, not through
    // the button's promise: stand the notice down the moment Zoom says the
    // user is authorized again, and say so, since the dialog they clicked
    // through gave them no other confirmation that the popups will stop.
    const standDown = () => {
      stateRef.current = CONNECTION_CONNECTED;
      setState(CONNECTION_CONNECTED);
      setModalOpen(false);
      trackEvent('zoom_reauthorized');
      showToast('Approved. Zoom will stop asking permission for background changes.', 'success', 5000);
    };

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
        resolvedRef.current = true;
        if (!needsAttention(resolved)) return;

        raise(resolved, launch, 'on_open');
      });

    // The same SDK event fires for role changes (host to co-host), screen-name
    // changes and approvals, so what it means depends on what is showing:
    // - authorized while the guest-mode notice is up: the approval landed.
    // - authenticated while connected: Zoom dropped the grant mid-session, so
    //   raise the same guest-mode notice the user would have seen on open.
    // Everything else is ignored: authorized while connected is a role or
    // name change; unauthenticated and null (a failed read) are not evidence
    // of a lost grant, as on open; and the re-add notices are decided at open.
    setUserStatusChangeCallback((status) => {
      if (cancelled || !resolvedRef.current) return;
      const current = stateRef.current;
      if (status === STATUS_AUTHORIZED && current === CONNECTION_UNAUTHORIZED) {
        standDown();
        return;
      }
      if (status === STATUS_AUTHENTICATED && current === CONNECTION_CONNECTED) {
        raise(CONNECTION_UNAUTHORIZED, readLaunchContext(), 'mid_session');
      }
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
    await handOff(installUrl(), 'zoom_reconnect_clicked', { returning_user: returning, fallback: true });
  };

  const reAdd = () =>
    state === CONNECTION_UNAUTHORIZED
      ? approveInZoom()
      : handOff(installUrl(), 'zoom_reconnect_clicked', { returning_user: returning });
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

      {/* Mounted only while a modal is queued, so the timer tick it reads
          never re-renders the banner above for the rest of the session. */}
      {modalOpen && (
        <ConnectionModal
          copy={copy}
          returning={returning}
          onPrimary={reAdd}
          onBrowserTimer={browserTimer}
          onWhy={why}
          onClose={closeModal}
        />
      )}
    </>
  );
}

/**
 * The loud half of the notice. It never covers a running timer: a drop
 * reported mid-speech queues the modal until the speaker is stopped, the
 * same polite interrupt PeriodicPrompts uses. The banner is already up and
 * carries the fix, so nothing is lost by waiting. There is no grace delay
 * after the stop, unlike the prompts: this is about the app's own state,
 * not an ask.
 */
function ConnectionModal({ copy, returning, onPrimary, onBrowserTimer, onWhy, onClose }) {
  const { isRunning } = useTimerTick();
  if (isRunning) return null;

  return (
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
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-5">{copy.body}</p>

        <div className="flex flex-col gap-2">
          <button
            onClick={onPrimary}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors text-sm"
          >
            <ExternalLink className="w-4 h-4" />
            {copy.cta}
          </button>
          <button
            onClick={onBrowserTimer}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold rounded-lg transition-colors text-sm"
          >
            Use the browser timer instead
          </button>
        </div>

        {returning && (
          <button
            onClick={onWhy}
            className="mt-3 w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Why did this happen?
          </button>
        )}
      </div>
    </div>
  );
}
