import '@testing-library/jest-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ZoomConnectionNotice from './ZoomConnectionNotice';
import { ToastProvider } from '../context/ToastContext';
import { ZOOM_INSTALL_URL, TIMER_APP_URL } from '@toastmaster-timer/shared';
import {
  initializeZoomSdk,
  openExternalUrl,
  promptZoomAuthorize,
  readZoomUserStatus,
  setUserStatusChangeCallback,
} from '../utils/zoomSdk';
import { trackEvent } from '../utils/posthog';

// The component prefers VITE_ZOOM_OAUTH_REDIRECT and falls back to the shared
// constant; a developer's root .env sets the variable, CI does not. Mirror
// that choice so the test passes in both places.
const INSTALL_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT || ZOOM_INSTALL_URL;

// What the dev Worker stamps: the dev Zoom app, sending the browser back to the
// dev origin. Deliberately not the build-time value.
const STAMPED_INSTALL_URL =
  'https://zoom.us/oauth/authorize?response_type=code&client_id=dev-client&redirect_uri=https%3A%2F%2Fwww.timer-dev.simple-tech.app%2Foauth%2Fredirect';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  initializeZoomSdk: vi.fn(),
  openExternalUrl: vi.fn(),
  promptZoomAuthorize: vi.fn(),
  readZoomUserStatus: vi.fn(),
  setUserStatusChangeCallback: vi.fn(),
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

function setLaunchContext(value) {
  document.head.querySelector('meta[name="zoom-launch"]')?.remove();
  if (!value) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'zoom-launch');
  meta.setAttribute('content', value);
  document.head.appendChild(meta);
}

function setInstallUrl(value) {
  document.head.querySelector('meta[name="zoom-install-url"]')?.remove();
  if (!value) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'zoom-install-url');
  meta.setAttribute('content', value);
  document.head.appendChild(meta);
}

function renderNotice() {
  render(
    <ToastProvider>
      <ZoomConnectionNotice />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLaunchContext(null);
  setInstallUrl(null);
  openExternalUrl.mockResolvedValue(true);
  initializeZoomSdk.mockResolvedValue(false);
  // An older client that never says: the pre-guest-mode picture, and the one
  // every test below that is not about guest mode should keep seeing.
  readZoomUserStatus.mockResolvedValue(null);
  promptZoomAuthorize.mockResolvedValue(true);
});

/** The client shook hands, but reports the user as signed in without the app. */
function inGuestMode() {
  initializeZoomSdk.mockResolvedValue(true);
  readZoomUserStatus.mockResolvedValue('authenticated');
  setLaunchContext('client');
}

/** The client shook hands and the user has added the app: the healthy panel. */
function authorizedInZoom() {
  initializeZoomSdk.mockResolvedValue(true);
  readZoomUserStatus.mockResolvedValue('authorized');
  setLaunchContext('client');
}

/** The function the notice handed to setUserStatusChangeCallback. */
function statusCallback() {
  return setUserStatusChangeCallback.mock.calls.find(([cb]) => typeof cb === 'function')[0];
}

/**
 * Lets the mount's handshake and status read settle. A healthy mount changes
 * nothing on screen, so there is no element to wait for; one macrotask drains
 * every promise the mount chained.
 */
async function settleMount() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe('ZoomConnectionNotice', () => {
  it('says nothing at all when the handshake succeeded', async () => {
    initializeZoomSdk.mockResolvedValue(true);
    setLaunchContext('client');
    renderNotice();

    await waitFor(() => expect(initializeZoomSdk).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  // The case this whole feature exists for: Zoom opened the app, the SDK
  // refused, and the organizer used to be told nothing.
  it('names the cause when Zoom revoked a returning organizer’s access', async () => {
    setLaunchContext('client');
    localStorage.setItem('toastmaster_reports', '[{"name":"Ana"}]');
    renderNotice();

    const modal = within(await screen.findByRole('dialog'));
    expect(modal.getByText('Zoom removed this app’s access')).toBeInTheDocument();
    expect(modal.getByText(/agendas, roles and reports are safe on this device/)).toBeInTheDocument();
    expect(modal.getByRole('button', { name: /re-add to zoom/i })).toBeInTheDocument();
  });

  it('offers install copy, not recovery copy, to someone with no saved work', async () => {
    setLaunchContext('client');
    renderNotice();

    const modal = within(await screen.findByRole('dialog'));
    expect(modal.getByText('Add Toastmusters Timer to Zoom')).toBeInTheDocument();
    expect(screen.queryByText(/Zoom removed this app’s access/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /why did this happen/i })).not.toBeInTheDocument();
  });

  it('uses out-of-Zoom wording for a browser tab', async () => {
    setLaunchContext('browser');
    localStorage.setItem('toastmaster_agenda', '[{"role":"Speaker 1"}]');
    renderNotice();

    const modal = within(await screen.findByRole('dialog'));
    expect(modal.getByText('Not connected to Zoom')).toBeInTheDocument();
  });

  it('sends the re-add button through the SDK to the install flow', async () => {
    const user = userEvent.setup();
    setLaunchContext('client');
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /add to zoom/i }));

    expect(openExternalUrl).toHaveBeenCalledWith(INSTALL_URL);
    expect(trackEvent).toHaveBeenCalledWith('zoom_reconnect_clicked', expect.any(Object));
  });

  // A build-time link names one Zoom app for every deployment; the Worker
  // stamps the one it actually belongs to, and that has to win — the dev host
  // used to send its guests through the production install.
  it('prefers the install link the Worker stamped for this deployment', async () => {
    const user = userEvent.setup();
    setLaunchContext('client');
    setInstallUrl(STAMPED_INSTALL_URL);
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /add to zoom/i }));

    expect(openExternalUrl).toHaveBeenCalledWith(STAMPED_INSTALL_URL);
  });

  it('sends the guest-mode browser fallback to the stamped link too', async () => {
    const user = userEvent.setup();
    inGuestMode();
    setInstallUrl(STAMPED_INSTALL_URL);
    promptZoomAuthorize.mockResolvedValue(false);
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /approve in zoom/i }));

    expect(openExternalUrl).toHaveBeenCalledWith(STAMPED_INSTALL_URL);
  });

  // A meeting may be starting in seconds; the browser timer keeps it running.
  it('offers the browser timer as an escape hatch', async () => {
    const user = userEvent.setup();
    setLaunchContext('browser');
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /use the browser timer/i }));

    expect(openExternalUrl).toHaveBeenCalledWith(TIMER_APP_URL);
  });

  // The Zoom client refuses openUrl until the capability is live, and a plain
  // window.open is blocked in the webview — so a dead button is a real outcome.
  it('explains itself when the hand-off to the browser fails', async () => {
    const user = userEvent.setup();
    openExternalUrl.mockResolvedValue(false);
    setLaunchContext('client');
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /add to zoom/i }));

    expect(await screen.findByText(/Zoom App Marketplace/)).toBeInTheDocument();
  });

  it('keeps the banner but drops the modal once it has been dismissed this session', async () => {
    const user = userEvent.setup();
    setLaunchContext('client');
    renderNotice();
    await screen.findByRole('status');

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // Once the modal is gone the banner is all that is left, so it has to act,
  // not re-explain.
  it('re-adds straight from the banner after the modal is dismissed', async () => {
    const user = userEvent.setup();
    setLaunchContext('client');
    renderNotice();
    const banner = within(await screen.findByRole('status'));

    await user.click(banner.getByRole('button', { name: /add to zoom/i }));

    expect(openExternalUrl).toHaveBeenCalledWith(INSTALL_URL);
  });

  it('reports the degraded state once, with what caused it', async () => {
    setLaunchContext('client');
    localStorage.setItem('toastmaster_agenda', '[{"role":"Speaker 1"}]');
    renderNotice();
    await screen.findByRole('status');

    expect(trackEvent).toHaveBeenCalledWith('zoom_connection_degraded', {
      connection_state: 'revoked',
      launch_context: 'client',
      returning_user: true,
      detected: 'on_open',
    });
  });

  // Zoom drops every user's grant when the app's scopes change. The app still
  // opens, so the revoked notice never fires — but the client now asks the
  // user's permission on every color change, which is the bug this catches.
  it('tells a guest-mode user why Zoom keeps asking, and offers the in-client fix', async () => {
    inGuestMode();
    localStorage.setItem('toastmaster_agenda', '[{"role":"Speaker 1"}]');
    renderNotice();

    const modal = within(await screen.findByRole('dialog'));
    expect(modal.getByText('Approve Toastmusters Timer in Zoom')).toBeInTheDocument();
    expect(modal.getByText(/every time the timer changes your background/)).toBeInTheDocument();
    expect(modal.getByText(/agendas, roles and reports exactly where they are/)).toBeInTheDocument();
    expect(modal.getByRole('button', { name: /approve in zoom/i })).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('zoom_connection_degraded', expect.objectContaining({
      connection_state: 'unauthorized',
    }));
  });

  it('does not read the status, or nag, when the user is authorized', async () => {
    initializeZoomSdk.mockResolvedValue(true);
    readZoomUserStatus.mockResolvedValue('authorized');
    setLaunchContext('client');
    renderNotice();

    await waitFor(() => expect(readZoomUserStatus).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // The fix lives inside the client: Zoom's own add-the-app prompt, with no
  // trip to a browser. Sending them to the install URL instead would work but
  // costs a browser tab mid-meeting.
  it('approves through Zoom\'s own prompt rather than the browser', async () => {
    const user = userEvent.setup();
    inGuestMode();
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /approve in zoom/i }));

    expect(promptZoomAuthorize).toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('zoom_reauthorize_clicked', expect.any(Object));
    // The prompt is Zoom's to show; ours closes so the two are not stacked.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The banner holds until Zoom actually reports the grant restored.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // A client that refused promptAuthorize can still be fixed the long way.
  it('falls back to the browser install flow when the client refuses promptAuthorize', async () => {
    const user = userEvent.setup();
    inGuestMode();
    promptZoomAuthorize.mockResolvedValue(false);
    renderNotice();
    const modal = within(await screen.findByRole('dialog'));

    await user.click(modal.getByRole('button', { name: /approve in zoom/i }));

    expect(openExternalUrl).toHaveBeenCalledWith(INSTALL_URL);
    expect(trackEvent).toHaveBeenCalledWith('zoom_reconnect_clicked', expect.objectContaining({ fallback: true }));
  });

  // The approval happens in Zoom's dialog, which tells the app nothing on its
  // own; the SDK's status-change event is the only word that it worked.
  it('stands down the moment Zoom reports the user authorized again', async () => {
    inGuestMode();
    renderNotice();
    await screen.findByRole('status');
    await waitFor(() => expect(setUserStatusChangeCallback).toHaveBeenCalledWith(expect.any(Function)));
    const onStatus = setUserStatusChangeCallback.mock.calls.find(([cb]) => typeof cb === 'function')[0];

    // Signing in without adding the app is not the fix; nothing changes.
    act(() => onStatus('authenticated'));
    expect(screen.getByRole('status')).toBeInTheDocument();

    act(() => onStatus('authorized'));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText(/Zoom will stop asking permission/)).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('zoom_reauthorized');
  });

  // onMyUserContextChange also fires when the organizer is made co-host. An
  // authorized user who was never shown the notice must not be congratulated.
  it('says nothing on a status report while no notice is up', async () => {
    authorizedInZoom();
    renderNotice();
    await settleMount();

    act(() => statusCallback()('authorized'));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Zoom will stop asking permission/)).not.toBeInTheDocument();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  // The open-time check used to be the only one: a grant Zoom dropped while
  // the panel was up left the organizer in guest mode, clicking "Allow" on
  // every color change, until they happened to reload.
  it('raises the guest-mode notice when Zoom drops the grant mid-session', async () => {
    authorizedInZoom();
    localStorage.setItem('toastmaster_agenda', '[{"role":"Speaker 1"}]');
    renderNotice();
    await settleMount();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => statusCallback()('authenticated'));

    const banner = within(screen.getByRole('status'));
    expect(banner.getByText(/asks permission on every color change/)).toBeInTheDocument();
    expect(banner.getByRole('button', { name: /approve in zoom/i })).toBeInTheDocument();
    const modal = within(screen.getByRole('dialog'));
    expect(modal.getByText('Approve Toastmusters Timer in Zoom')).toBeInTheDocument();
    expect(modal.getByText(/agendas, roles and reports exactly where they are/)).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('zoom_connection_degraded', {
      connection_state: 'unauthorized',
      launch_context: 'client',
      returning_user: true,
      detected: 'mid_session',
    });
  });

  // Neither is evidence of a lost grant: an unauthenticated user was never
  // signed in, and null is a status read that failed. The open-time check
  // ignores both too.
  it.each(['unauthenticated', null])('ignores a mid-session %s report', async (status) => {
    authorizedInZoom();
    renderNotice();
    await settleMount();

    act(() => statusCallback()(status));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  // The status callback is registered before the handshake settles, and until
  // then the notice still holds its "connected" placeholder. A report in that
  // window must not raise a second notice, or count a second drop, on top of
  // what the mount itself is about to read.
  it('ignores a status report that arrives before the mount has read the status', async () => {
    let finishHandshake;
    initializeZoomSdk.mockReturnValue(new Promise((resolve) => { finishHandshake = resolve; }));
    readZoomUserStatus.mockResolvedValue('authenticated');
    setLaunchContext('client');
    renderNotice();
    await waitFor(() => expect(setUserStatusChangeCallback).toHaveBeenCalledWith(expect.any(Function)));

    act(() => statusCallback()('authenticated'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(trackEvent).not.toHaveBeenCalled();

    await act(async () => finishHandshake(true));

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('zoom_connection_degraded', expect.objectContaining({
      connection_state: 'unauthorized',
      detected: 'on_open',
    }));
  });

  // Two quick context changes can both arrive before React re-renders; the
  // drop is still one drop.
  it('counts back-to-back drop reports once', async () => {
    authorizedInZoom();
    renderNotice();
    await settleMount();
    const onStatus = statusCallback();

    act(() => {
      onStatus('authenticated');
      onStatus('authenticated');
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  // The re-add notices are decided at open and stay as they are: a status
  // report cannot turn "Zoom removed this app's access" into guest mode.
  it('leaves a re-add notice alone when a status report arrives', async () => {
    setLaunchContext('client');
    renderNotice();
    await screen.findByRole('status');
    await settleMount();
    vi.mocked(trackEvent).mockClear();

    act(() => statusCallback()('authenticated'));
    act(() => statusCallback()('authorized'));

    expect(screen.getByRole('status')).toHaveTextContent('Add Toastmusters Timer to Zoom');
    expect(trackEvent).not.toHaveBeenCalled();
  });

  // The modal explains itself once per Zoom session, whichever way the notice
  // came up. A grant that drops again later in the same meeting brings back
  // the banner, which carries the fix, without re-covering the panel.
  it('brings back only the banner on a second drop once the modal was closed', async () => {
    const user = userEvent.setup();
    authorizedInZoom();
    renderNotice();
    await settleMount();
    const onStatus = statusCallback();

    act(() => onStatus('authenticated'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    act(() => onStatus('authorized'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => onStatus('authenticated'));

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('zoom_reauthorized');
    expect(trackEvent.mock.calls.filter(([event]) => event === 'zoom_connection_degraded')).toHaveLength(2);
  });

  // Same rule for a modal already closed at open: a mid-session drop after
  // the user approved does not explain itself a second time.
  it('keeps the modal closed on a mid-session drop if it was closed on open', async () => {
    const user = userEvent.setup();
    inGuestMode();
    renderNotice();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /close/i }));
    act(() => statusCallback()('authorized'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    act(() => statusCallback()('authenticated'));

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('zoom_connection_degraded', expect.objectContaining({
      detected: 'mid_session',
    }));
  });

  it('stops listening for status changes when it unmounts', async () => {
    inGuestMode();
    const { unmount } = render(
      <ToastProvider>
        <ZoomConnectionNotice />
      </ToastProvider>
    );
    await screen.findByRole('status');

    unmount();

    expect(setUserStatusChangeCallback).toHaveBeenLastCalledWith(null);
  });
});
