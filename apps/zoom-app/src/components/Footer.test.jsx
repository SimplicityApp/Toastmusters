import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import Footer from './Footer';
import { ToastProvider } from '../context/ToastContext';
import {
  PRO_LAUNCH_BADGE_DAYS,
  PRO_LAUNCH_PROMPT,
  markPromptAnswered,
  markPromptShown,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

const PRO = { plan: 'pro', status: 'active', entitled: true, source: 'subscription' };

function renderFooter() {
  return render(
    <ToastProvider>
      <Footer />
    </ToastProvider>
  );
}

const upgradeButton = () => screen.queryByRole('button', { name: /upgrade to pro/i });
const proButton = () => screen.queryByRole('button', { name: /manage your pro plan/i });

// The real stores, not a mocked hook: what is under test is the gate the
// Footer composes from both of them.
beforeEach(() => {
  localStorage.clear();
  resetEntitlementForTests();
  resetFlagsForTests();
});

describe('the Footer\'s Pro button', () => {
  it('shows nothing until either answer lands', () => {
    renderFooter();
    expect(upgradeButton()).toBeNull();
    expect(proButton()).toBeNull();
  });

  it('shows nothing while the flags are still unknown, even with the plan known', () => {
    setEntitlement({ plan: 'free' });
    renderFooter();
    expect(upgradeButton()).toBeNull();
  });

  it('shows nothing while the plan is still unknown, even with the flag on', () => {
    setFlags({ pro: true });
    renderFooter();
    expect(upgradeButton()).toBeNull();
  });

  it('stays hidden when pro is off', () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: false });
    renderFooter();
    expect(upgradeButton()).toBeNull();
  });

  it('stays hidden for a Pro user too when pro is off', () => {
    setEntitlement(PRO);
    setFlags({ pro: false });
    renderFooter();
    expect(proButton()).toBeNull();
  });

  // What an offline load or a failed session call records: known, all off.
  it('stays hidden when the server sent no flags at all', () => {
    setEntitlement({ plan: 'free' });
    setFlags(null);
    renderFooter();
    expect(upgradeButton()).toBeNull();
  });

  it('offers the upgrade to a free user once the flag is on', () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    renderFooter();
    expect(upgradeButton()).toBeInTheDocument();
    expect(screen.getByText('Upgrade')).toBeInTheDocument();
  });

  it('shows the Pro badge to a Pro user once the flag is on', () => {
    setEntitlement(PRO);
    setFlags({ pro: true });
    renderFooter();
    expect(proButton()).toBeInTheDocument();
    expect(upgradeButton()).toBeNull();
  });

  it('appears the moment the session answer lands, without a remount', () => {
    renderFooter();
    expect(upgradeButton()).toBeNull();

    act(() => {
      setEntitlement({ plan: 'free' });
      setFlags({ pro: true });
    });
    expect(upgradeButton()).toBeInTheDocument();
  });

  it('leaves the other footer buttons alone whatever the flag says', () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: false });
    renderFooter();
    expect(screen.getByRole('button', { name: /provide feedback/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /leave a review/i })).toBeInTheDocument();
  });
});

describe('the "New" badge on the Upgrade button', () => {
  const badge = () => screen.queryByText('New');
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('marks the Upgrade button for a free user once Pro is released', () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    renderFooter();
    expect(upgradeButton()).toContainElement(badge());
  });

  it('is not on a Pro user\'s button', () => {
    setEntitlement(PRO);
    setFlags({ pro: true });
    renderFooter();
    expect(badge()).toBeNull();
  });

  it('goes the moment the announcement is answered, without a remount', () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    renderFooter();
    expect(badge()).toBeInTheDocument();

    act(() => {
      markPromptAnswered(PRO_LAUNCH_PROMPT);
    });
    expect(badge()).toBeNull();
    expect(upgradeButton()).toBeInTheDocument();
  });

  it('is gone once the badge window after the announcement has passed', () => {
    markPromptShown(PRO_LAUNCH_PROMPT, Date.now() - (PRO_LAUNCH_BADGE_DAYS + 1) * DAY_MS);
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    renderFooter();
    expect(upgradeButton()).toBeInTheDocument();
    expect(badge()).toBeNull();
  });
});
