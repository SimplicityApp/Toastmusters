import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import {
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';
import CardImagesModal from './CardImagesModal';
import { ToastProvider } from '../context/ToastContext';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  getCardFileUrl: vi.fn((file) => `/cards/${file}`),
  notifyCardImagesChanged: vi.fn(),
  preloadBackgroundImages: vi.fn(),
  notifyOwnBackgroundChanged: vi.fn(),
  applyOwnBackground: vi.fn(),
  removeOwnBackground: vi.fn(),
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(async () => ({ identified: true, uid: 'u1' })),
  getSessionToken: vi.fn(() => 'session-token'),
}));

async function renderModal() {
  render(
    <ToastProvider>
      <CardImagesModal isOpen onClose={vi.fn()} />
    </ToastProvider>
  );
  // The stored artwork loads asynchronously and re-renders the modal once it
  // is in; let that land before asserting.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

const upgradeLink = () => screen.queryByRole('button', { name: /upgrade to pro/i });
const storageNote = () => screen.getByText(/Custom images are stored only in this browser/);

// The real stores, not a mocked hook: what is under test is the gate the note
// composes from both of them.
beforeEach(() => {
  localStorage.clear();
  resetEntitlementForTests();
  resetFlagsForTests();
});

/**
 * The note under the uploaders. For a free user it points at Pro, but the
 * purchase is dark until pro is released, so until then it reads the
 * way it does while the plan is still unknown: the fact, and no link.
 */
describe('the card images storage note', () => {
  it('links to the upgrade once the plan is free and pro is on', async () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    await renderModal();

    expect(upgradeLink()).toBeInTheDocument();
  });

  it.each([
    ['the plan is still unknown', () => setFlags({ pro: true })],
    ['the flags are still unknown', () => setEntitlement({ plan: 'free' })],
    ['pro is off', () => {
      setEntitlement({ plan: 'free' });
      setFlags({ pro: false });
    }],
  ])('says the images stay in this browser, with no link, while %s', async (_, seed) => {
    seed();
    await renderModal();

    expect(storageNote()).toBeInTheDocument();
    expect(upgradeLink()).toBeNull();
  });

  it('tells a Pro user their images follow them, whatever the flag says', async () => {
    setEntitlement({ plan: 'pro', status: 'active', entitled: true, source: 'subscription' });
    setFlags({ pro: false });
    await renderModal();

    expect(screen.getByText(/backed up and follow you to your other devices/)).toBeInTheDocument();
    expect(upgradeLink()).toBeNull();
  });
});
