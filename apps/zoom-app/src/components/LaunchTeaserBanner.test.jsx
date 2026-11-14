import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import LaunchTeaserBanner, { LAUNCH_TEASER_DISMISSED_KEY } from './LaunchTeaserBanner';
import { trackEvent } from '../utils/posthog';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  resetFlagsForTests();
  trackEvent.mockClear();
});

describe('LaunchTeaserBanner', () => {
  it('says a new look and Pro are coming while pro is off', () => {
    setFlags({ pro: false, sounds: true });
    render(<LaunchTeaserBanner />);
    expect(screen.getByTestId('launch-teaser-banner')).toHaveTextContent(
      'Coming soon: a fresh new look for the timer, and Pro features for your club.',
    );
    expect(trackEvent).toHaveBeenCalledWith('launch_teaser_banner_shown', { surface: 'zoom' });
  });

  it('stays hidden until the flags are known, so it never flashes', () => {
    render(<LaunchTeaserBanner />);
    expect(screen.queryByTestId('launch-teaser-banner')).toBeNull();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('retires itself once pro is released', () => {
    setFlags({ pro: true, sounds: true });
    render(<LaunchTeaserBanner />);
    expect(screen.queryByTestId('launch-teaser-banner')).toBeNull();
  });

  it('stays dismissed on this device', () => {
    setFlags({ pro: false });
    const first = render(<LaunchTeaserBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('launch-teaser-banner')).toBeNull();
    expect(localStorage.getItem(LAUNCH_TEASER_DISMISSED_KEY)).toBe('1');
    expect(trackEvent).toHaveBeenCalledWith('launch_teaser_banner_dismissed', { surface: 'zoom' });
    first.unmount();

    render(<LaunchTeaserBanner />);
    expect(screen.queryByTestId('launch-teaser-banner')).toBeNull();
  });
});
