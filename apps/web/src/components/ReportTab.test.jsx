import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  CLUB_STORAGE_KEY,
  CLUB_OUTBOX_STORAGE_KEY,
  resetClubForTests,
  resetClubArchiveForTests,
  resetEntitlementForTests,
} from '@toastmaster-timer/shared';
import { TimerProvider, useTimer } from '../context/TimerContext';
import { ToastProvider } from '../context/ToastContext';
import ReportTab from './ReportTab';
import { renderWithProviders } from '../test/helpers';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn(), initPostHog: vi.fn(), identifyUser: vi.fn() }));
import { trackEvent } from '../utils/posthog';

/** A club this device has joined, as the cache holds it. */
const cachedClub = (over = {}) => ({
  clubToken: 'club.tok',
  ver: 1,
  club: { id: 'club-1', name: 'Downtown Speakers' },
  kit: { name: 'Downtown Speakers', logoUrl: null, primaryColor: '#772432', showOnCards: true, showOnReports: true },
  badge: null,
  timezone: 'America/Toronto',
  role: null,
  plan: 'pro',
  entitled: true,
  status: 'active',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: 'club',
  lastRefreshAt: Date.now(),
  ...over,
});

function joinClub(over) {
  localStorage.setItem(CLUB_STORAGE_KEY, JSON.stringify(cachedClub(over)));
  resetClubForTests();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetClubForTests();
  resetClubArchiveForTests();
  resetEntitlementForTests();
  global.fetch = vi.fn();
});

// Wrapper that pre-populates reports before rendering ReportTab
function ReportTabWithData() {
  const { addReport } = useTimer();
  useEffect(() => {
    addReport({
      name: 'Alice',
      role: 'Standard Speech',
      duration: 350,
      color: 'green',
      comments: '',
      disqualified: false,
    });
    addReport({
      name: 'Bob',
      role: 'Ice Breaker',
      duration: 400,
      color: 'red',
      comments: 'Passed red by 40 seconds',
      disqualified: false,
    });
  }, []);
  return <ReportTab />;
}

function renderWithData() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <TimerProvider>
          <ReportTabWithData />
        </TimerProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('ReportTab', () => {
  describe('empty state', () => {
    it('renders "No reports yet" message when there are no reports', () => {
      renderWithProviders(<ReportTab />);
      expect(
        screen.getByText(/no reports yet/i)
      ).toBeInTheDocument();
    });

    it('does not render the table when there are no reports', () => {
      renderWithProviders(<ReportTab />);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('does not render Copy or Clear buttons when there are no reports', () => {
      renderWithProviders(<ReportTab />);
      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    });
  });

  describe('with reports', () => {
    it('renders the report table with Alice and Bob visible', async () => {
      renderWithData();
      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getByText('Bob')).toBeInTheDocument();
      });
    });

    it('renders all expected table headers', async () => {
      renderWithData();
      await waitFor(() => {
        expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Role' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Time' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Over time' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Comments' })).toBeInTheDocument();
      });
    });

    it('renders report data for Alice with correct role and color', async () => {
      renderWithData();
      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
        expect(screen.getByText('Standard Speech')).toBeInTheDocument();
        expect(screen.getByText('green')).toBeInTheDocument();
      });
    });

    it('renders report data for Bob with comments', async () => {
      renderWithData();
      await waitFor(() => {
        expect(screen.getByText('Bob')).toBeInTheDocument();
        expect(screen.getByText('Ice Breaker')).toBeInTheDocument();
        expect(screen.getByText('Passed red by 40 seconds')).toBeInTheDocument();
      });
    });

    it('renders Copy Report button', async () => {
      renderWithData();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /copy report to clipboard/i })
        ).toBeInTheDocument();
      });
    });

    it('renders Clear button', async () => {
      renderWithData();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /clear/i })
        ).toBeInTheDocument();
      });
    });
  });

  describe('clear reports flow', () => {
    it('shows ConfirmModal when Clear is clicked', async () => {
      const user = userEvent.setup();
      renderWithData();

      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
      });

      const clearButton = screen.getByRole('button', { name: /clear/i });
      await user.click(clearButton);

      expect(screen.getByText('Clear All Reports')).toBeInTheDocument();
      expect(
        screen.getByText(/are you sure you want to clear all reports/i)
      ).toBeInTheDocument();
    });

    it('dismisses ConfirmModal without clearing when Cancel is clicked', async () => {
      const user = userEvent.setup();
      renderWithData();

      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /clear/i }));
      expect(screen.getByText('Clear All Reports')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByText('Clear All Reports')).not.toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('clears all reports when Clear All is confirmed', async () => {
      const user = userEvent.setup();
      renderWithData();

      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /clear/i }));
      expect(screen.getByText('Clear All Reports')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /clear all/i }));

      await waitFor(() => {
        expect(screen.getByText(/no reports yet/i)).toBeInTheDocument();
      });

      expect(screen.queryByText('Alice')).not.toBeInTheDocument();
      expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    });
  });

  // The archive is the one Pro surface on this tab: a free device must not be
  // able to tell any of it exists.
  describe('the club archive', () => {
    it('says nothing at all on a device with no club', () => {
      renderWithProviders(<ReportTab />);
      expect(screen.queryByTestId('club-archive-indicator')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /history/i })).not.toBeInTheDocument();
    });

    it('says nothing once the club has lapsed', () => {
      joinClub({ entitled: false, plan: 'free', status: 'canceled' });
      renderWithProviders(<ReportTab />);
      expect(screen.queryByTestId('club-archive-indicator')).not.toBeInTheDocument();
    });

    it('names the club it is saving to, even before any speech is timed', () => {
      joinClub();
      renderWithProviders(<ReportTab />);
      expect(screen.getByTestId('club-archive-indicator')).toHaveTextContent('Saved to Downtown Speakers');
    });

    // The indicator reads outbox emptiness, so a device that lost the network
    // mid-meeting shows work pending rather than claiming success.
    it('shows work pending while speeches are still queued', () => {
      joinClub();
      localStorage.setItem(
        CLUB_OUTBOX_STORAGE_KEY,
        JSON.stringify([
          { speechId: 'a', meetingId: '20260929', name: 'Alice' },
          { speechId: 'b', meetingId: '20260929', name: 'Bob' },
        ])
      );
      renderWithProviders(<ReportTab />);
      expect(screen.getByTestId('club-archive-indicator')).toHaveTextContent('2 speeches waiting to upload');
    });

    it('opens the club’s meetings, newest first, and tells analytics', async () => {
      const user = userEvent.setup();
      joinClub();
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          meetings: [
            { meetingId: '20260929', date: '2026-09-29', title: null, speeches: 6, overtime: 2, live: false },
            { meetingId: '20260922', date: '2026-09-22', title: 'Contest night', speeches: 4, overtime: 0 },
          ],
        }),
      });

      renderWithProviders(<ReportTab />);
      await user.click(screen.getByRole('button', { name: /history/i }));

      expect(await screen.findByTestId('report-history-list')).toBeInTheDocument();
      expect(screen.getByText('Contest night')).toBeInTheDocument();
      expect(screen.getByText(/2 meetings · 10 speeches/)).toBeInTheDocument();
      expect(global.fetch.mock.calls[0][0]).toBe('/api/club/meetings');
      expect(global.fetch.mock.calls[0][1].headers['X-Club']).toBe('club.tok');
      expect(trackEvent).toHaveBeenCalledWith('report_history_viewed', { meetings: 2, surface: 'web' });
    });

    it('opens one meeting and lists the speeches in it', async () => {
      const user = userEvent.setup();
      joinClub();
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ meetings: [{ meetingId: '20260929', date: '2026-09-29', speeches: 1, overtime: 0 }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            meeting: {
              meetingId: '20260929',
              date: '2026-09-29',
              speeches: [{ speechId: 's1', name: 'Priya', role: 'Ice Breaker', duration: '4:12', comments: '' }],
            },
          }),
        });

      renderWithProviders(<ReportTab />);
      await user.click(screen.getByRole('button', { name: /history/i }));
      await user.click(await screen.findByTestId('meeting-20260929'));

      expect(await screen.findByText('Priya')).toBeInTheDocument();
      expect(global.fetch.mock.calls[1][0]).toBe('/api/club/meetings/20260929');
    });

    // Offline in a church hall is the normal case. Nothing is lost, and the
    // copy has to say so rather than looking like data loss.
    it('says the club is unreachable rather than failing, when the network is down', async () => {
      const user = userEvent.setup();
      joinClub();
      global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

      renderWithProviders(<ReportTab />);
      await user.click(screen.getByRole('button', { name: /history/i }));

      expect(await screen.findByTestId('report-history-error')).toHaveTextContent(/Nothing is lost/);
    });
  });
});
