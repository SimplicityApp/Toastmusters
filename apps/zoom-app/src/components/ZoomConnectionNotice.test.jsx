import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ZoomConnectionNotice from './ZoomConnectionNotice';
import { ToastProvider } from '../context/ToastContext';
import { ZOOM_INSTALL_URL, TIMER_APP_URL } from '@toastmaster-timer/shared';
import { initializeZoomSdk, openExternalUrl } from '../utils/zoomSdk';
import { trackEvent } from '../utils/posthog';

// The component prefers VITE_ZOOM_OAUTH_REDIRECT and falls back to the shared
// constant; a developer's root .env sets the variable, CI does not. Mirror
// that choice so the test passes in both places.
const INSTALL_URL = import.meta.env.VITE_ZOOM_OAUTH_REDIRECT || ZOOM_INSTALL_URL;

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  initializeZoomSdk: vi.fn(),
  openExternalUrl: vi.fn(),
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
  openExternalUrl.mockResolvedValue(true);
  initializeZoomSdk.mockResolvedValue(false);
});

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
    });
  });
});
