import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Footer from './Footer';
import { ToastProvider } from '../context/ToastContext';
import { trackEvent } from '../utils/posthog';
import { resetEntitlementForTests, resetFlagsForTests, setEntitlement, setFlags } from '@toastmaster-timer/shared';

/**
 * The Footer warms the Pro panel's chunk after the first paint, so the code
 * field is there when the click lands. A click that beats the warm-up opens
 * the lazy panel; when the warm-up has landed, the next Footer render must
 * keep the same component, or React remounts the open panel and the typed
 * code is lost. Opening the panel is itself such a render: it retires the
 * Footer's "New" dot.
 *
 * In its own file: the warmed component is module state in Footer.jsx, and
 * this needs it not yet warmed.
 */

vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn(), promptZoomAuthorize: vi.fn(), readZoomUserSummary: vi.fn() }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(async () => ({ identified: true, uid: 'u1', authStatus: 'authorized' })),
  refreshZoomIdentity: vi.fn(async () => ({ identified: true, uid: 'u1', authStatus: 'authorized' })),
  getSessionToken: vi.fn(() => 'session-token'),
}));

beforeEach(() => {
  localStorage.clear();
  resetEntitlementForTests();
  resetFlagsForTests();
});

const shown = () => trackEvent.mock.calls.filter(([name]) => name === 'upgrade_prompt_shown');

it('keeps the open Pro panel mounted once its preload has landed', async () => {
  setFlags({ pro: true });
  setEntitlement({ plan: 'free' });
  render(
    <ToastProvider>
      <Footer />
    </ToastProvider>
  );

  // Before the warm-up has settled.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /upgrade to pro/i }));
  });
  await waitFor(() => expect(shown()).toHaveLength(1));

  // Let every render the opening caused settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(shown()).toHaveLength(1);
});
