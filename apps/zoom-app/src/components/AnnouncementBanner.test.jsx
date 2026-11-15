import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ANNOUNCEMENTS_DISMISSED_KEY,
  resetFlagsForTests,
  setFlags,
} from '@toastmaster-timer/shared';
import AnnouncementBanner from './AnnouncementBanner';
import { trackEvent } from '../utils/posthog';
import { openExternalUrl } from '../utils/zoomSdk';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
// Stubbed: the real module pulls in @zoom/appssdk, which hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn() }));

const banner = () => screen.queryByTestId('announcement-banner');

beforeEach(() => {
  localStorage.clear();
  resetFlagsForTests();
  trackEvent.mockClear();
  openExternalUrl.mockClear();
});

describe('AnnouncementBanner with the shipped announcements', () => {
  it('says a new look and Pro are coming while pro is off', () => {
    setFlags({ pro: false, sounds: true });
    render(<AnnouncementBanner />);
    expect(banner()).toHaveAttribute('data-announcement-id', 'pre-launch-2026-11');
    expect(banner()).toHaveTextContent(
      'Coming soon: a fresh new look for the timer, and Pro features for your club.',
    );
    expect(trackEvent).toHaveBeenCalledWith('announcement_shown', {
      surface: 'zoom',
      announcement_id: 'pre-launch-2026-11',
    });
  });

  it('stays hidden until the flags are known, so it never flashes', () => {
    render(<AnnouncementBanner />);
    expect(banner()).toBeNull();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('retires the pre-launch notice once pro is released', () => {
    setFlags({ pro: true, sounds: true });
    render(<AnnouncementBanner />);
    expect(banner()).toBeNull();
  });

  it('stays closed on this device', () => {
    setFlags({ pro: false });
    const first = render(<AnnouncementBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(banner()).toBeNull();
    expect(JSON.parse(localStorage.getItem(ANNOUNCEMENTS_DISMISSED_KEY))).toEqual(['pre-launch-2026-11']);
    expect(trackEvent).toHaveBeenCalledWith('announcement_dismissed', {
      surface: 'zoom',
      announcement_id: 'pre-launch-2026-11',
    });
    first.unmount();

    render(<AnnouncementBanner />);
    expect(banner()).toBeNull();
  });
});

describe('AnnouncementBanner with any announcement', () => {
  const news = {
    id: 'news-1',
    lead: 'New:',
    text: 'club card sets.',
    tone: 'success',
    link: { label: 'How it works', url: 'https://www.timer.simple-tech.app/help' },
  };

  it('shows the lead, the text and the link, and opens the link outside Zoom', () => {
    render(<AnnouncementBanner announcements={[news]} />);
    expect(banner()).toHaveTextContent('New: club card sets. How it works');
    expect(banner()).toHaveClass('bg-green-50');
    fireEvent.click(screen.getByRole('button', { name: 'How it works' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.timer.simple-tech.app/help');
    expect(trackEvent).toHaveBeenCalledWith('announcement_link_opened', {
      surface: 'zoom',
      announcement_id: 'news-1',
    });
  });

  it('moves on to the next announcement after one is closed', () => {
    const later = { id: 'news-2', text: 'Something else.' };
    render(<AnnouncementBanner announcements={[news, later]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(banner()).toHaveAttribute('data-announcement-id', 'news-2');
    expect(banner()).toHaveTextContent('Something else.');
  });

  it('skips one meant only for the web app', () => {
    render(<AnnouncementBanner announcements={[{ id: 'web', text: 'Web only.', surfaces: ['web'] }]} />);
    expect(banner()).toBeNull();
  });
});
