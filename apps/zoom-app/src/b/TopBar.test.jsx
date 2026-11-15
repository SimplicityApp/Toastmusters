import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  TUTORIALS_URL,
  resetClubForTests,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';
import { ToastProvider } from '../context/ToastContext';
import { openExternalUrl } from '../utils/zoomSdk';
import { trackEvent } from '../utils/posthog';
import TopBar from './TopBar';

vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

const PRO = { plan: 'pro', status: 'active', entitled: true, source: 'subscription' };

function renderBar(props = {}) {
  const handlers = { onTabChange: vi.fn(), onClearVideo: vi.fn(), onOpenRules: vi.fn() };
  render(
    <ToastProvider>
      <TopBar activeTab="live" {...handlers} {...props} />
    </ToastProvider>
  );
  return handlers;
}

const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More' }));
const menuItems = () => screen.getAllByRole('menuitem').map((item) => item.textContent.trim());

beforeEach(() => {
  localStorage.clear();
  resetFlagsForTests();
  resetEntitlementForTests();
  resetClubForTests();
  vi.clearAllMocks();
});

describe('the section switch', () => {
  it('names the timer "Timer" and keeps its PostHog id', async () => {
    vi.useFakeTimers();
    try {
      const { onTabChange } = renderBar();
      expect(screen.getByRole('button', { name: 'Timer' })).toHaveAttribute('aria-current', 'page');
      fireEvent.click(screen.getByRole('button', { name: 'Agenda' }));
      expect(onTabChange).toHaveBeenCalledWith('agenda');
      act(() => vi.runAllTimers());
      expect(trackEvent).toHaveBeenCalledWith('tab_viewed', { tab_name: 'agenda', previous_tab: 'live', look: 'b' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Pro chip', () => {
  it('shows nothing until the flags are in', () => {
    renderBar();
    expect(screen.queryByRole('button', { name: /pro/i })).toBeNull();
  });

  it('is locked and says what is coming while pro is off', () => {
    setFlags({ pro: false });
    renderBar();
    const chip = screen.getByRole('button', { name: 'Pro (coming soon)' });
    fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Pro is coming soon' })).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('pro_coming_soon_opened', { trigger: 'click', surface: 'pro_chip' });
  });

  it('offers the upgrade with the launch dot to a free plan once pro is on', () => {
    setFlags({ pro: true });
    setEntitlement({ plan: 'free' });
    renderBar();
    expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument();
    expect(screen.getByTestId('pro-new-dot')).toBeInTheDocument();
  });

  it('manages the plan for Pro, without the dot', () => {
    setFlags({ pro: true });
    setEntitlement(PRO);
    renderBar();
    expect(screen.getByRole('button', { name: 'Manage your Pro plan' })).toBeInTheDocument();
    expect(screen.queryByTestId('pro-new-dot')).toBeNull();
  });
});

describe('the ⋯ menu', () => {
  it('holds the timer tools and the help while pro is off', () => {
    setFlags({ pro: false });
    renderBar();
    openMore();
    expect(menuItems()).toEqual([
      'Roles & timing rules',
      'Clear the timer from my video',
      'How-to videos',
      'Send feedback',
      'Rate the app',
    ]);
  });

  it('adds your plan and the club code once pro is on', () => {
    setFlags({ pro: true });
    setEntitlement({ plan: 'free' });
    renderBar();
    openMore();
    expect(screen.getByText('Your plan')).toBeInTheDocument();
    expect(menuItems()).toEqual(expect.arrayContaining(['See Pro', 'Join my club with a code']));
  });

  it('hands Clear and the rules to the shell, and closes', () => {
    const { onClearVideo, onOpenRules } = renderBar();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear the timer from my video' }));
    expect(onClearVideo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Roles & timing rules' }));
    expect(onOpenRules).toHaveBeenCalledTimes(1);
  });

  it('opens the tutorials and the Marketplace review in the browser', async () => {
    renderBar();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'How-to videos' }));
    expect(openExternalUrl).toHaveBeenCalledWith(TUTORIALS_URL);

    openMore();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rate the app' }));
    });
    expect(openExternalUrl).toHaveBeenLastCalledWith(expect.stringContaining('marketplace.zoom.us'));
  });

  it('moves between items with the arrow keys and closes on Escape', () => {
    renderBar();
    openMore();
    const first = screen.getAllByRole('menuitem')[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem')[1]).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
