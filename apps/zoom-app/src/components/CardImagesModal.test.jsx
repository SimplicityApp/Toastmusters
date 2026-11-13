import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  resetCardImagesForTests,
  resetClubForTests,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';
import { publishCardSet } from '@toastmaster-timer/shared';
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
// Only the publish is stubbed: the network and IndexedDB behind it are covered
// in packages/shared/__tests__/clubCards.test.js.
vi.mock('@toastmaster-timer/shared', async (importOriginal) => ({
  ...(await importOriginal()),
  publishCardSet: vi.fn(async () => ({ ok: true, ver: 3, cards: { label: null, images: { blue: 'a'.repeat(64) } } })),
}));
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
  resetClubForTests();
  resetCardImagesForTests();
});

/** Put this device in an entitled club, optionally with a published card set. */
function joinClub({ role = null, cards = { label: null, images: { blue: 'a'.repeat(64) } } } = {}) {
  localStorage.setItem(
    'toastmaster_club',
    JSON.stringify({ clubToken: 'club-token', ver: 2, club: { id: 'c1', name: 'Downtown Speakers' }, kit: null, entitled: true, plan: 'pro', role })
  );
  if (cards) localStorage.setItem('toastmaster_club_cards', JSON.stringify(cards));
  resetClubForTests();
}

/**
 * The club's set: on offer in the picker whenever the club has one, and shown
 * by default on a device that never chose cards of its own.
 */
describe('the club card set', () => {
  it('is listed, and selected, on a device with no cards of its own', async () => {
    joinClub();
    await renderModal();
    const row = screen.getByRole('radio', { name: /Downtown Speakers cards/ });
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Classic/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('is not listed when the club has not published one', async () => {
    joinClub({ cards: null });
    await renderModal();
    expect(screen.queryByRole('radio', { name: /Downtown Speakers cards/ })).toBeNull();
  });

  // Publishing rewrites every club device's cards, so the button is for the
  // people the server will accept it from.
  it.each([
    ['an editor', 'editor', true],
    ['an admin', 'admin', true],
    ['a member', 'member', false],
    ['a guest device', null, false],
  ])('offers Share with my club on a custom set to %s: %s', async (_, role, offered) => {
    joinClub({ role });
    localStorage.setItem(
      'toastmaster_custom_card_images',
      JSON.stringify({ version: 3, selectedSetId: 'custom-1', customSets: [{ id: 'custom-1', colors: ['blue'] }] })
    );
    await renderModal();
    const share = screen.queryByRole('button', { name: /Share the Custom 1 card set with my club/ });
    expect(Boolean(share)).toBe(offered);
  });

  // "Custom 1" names a slot on the publisher's device; every other club device
  // has its own "Custom 1", so sending it would show two rows with one name.
  it('publishes without the slot name, so the set reads "<club> cards"', async () => {
    joinClub({ role: 'admin', cards: null });
    localStorage.setItem(
      'toastmaster_custom_card_images',
      JSON.stringify({ version: 3, selectedSetId: 'custom-1', customSets: [{ id: 'custom-1', colors: ['blue'] }] })
    );
    await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Share the Custom 1 card set with my club/ }));
    });
    expect(publishCardSet).toHaveBeenCalledTimes(1);
    const [setId, options] = publishCardSet.mock.calls[0];
    expect(setId).toBe('custom-1');
    expect(options?.label).toBeUndefined();
  });

  it('uses the label the publisher gave it', async () => {
    joinClub({ cards: { label: 'Contest night', images: { red: 'b'.repeat(64) } } });
    await renderModal();
    expect(screen.getByRole('radio', { name: /Contest night/ })).toBeInTheDocument();
  });
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

  it('tells a Pro user their images follow them once pro is released', async () => {
    setEntitlement({ plan: 'pro', status: 'active', entitled: true, source: 'subscription' });
    setFlags({ pro: true });
    await renderModal();

    expect(screen.getByText(/backed up and follow you to your other devices/)).toBeInTheDocument();
    expect(upgradeLink()).toBeNull();
  });

  // The pro flag is the source of truth for Pro in the UI, so a Pro plan reads
  // as free while it is off.
  it('treats a Pro plan as free while pro is unreleased', async () => {
    setEntitlement({ plan: 'pro', status: 'active', entitled: true, source: 'subscription' });
    setFlags({ pro: false });
    await renderModal();

    expect(screen.getByText(/stored only in this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/backed up and follow you/)).toBeNull();
    expect(upgradeLink()).toBeNull();
  });
});
