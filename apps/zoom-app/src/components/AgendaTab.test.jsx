import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import AgendaTab from './AgendaTab';
import { trackEvent } from '../utils/posthog';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  applyOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
  isOverlayActive: vi.fn(() => false),
  getOverlayMode: vi.fn(() => 'card'),
  isVideoOverlayMode: vi.fn(() => false),
  setOverlayTimeLabel: vi.fn(),
  OVERLAY_MODE_CARD: 'card',
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

function renderWithProviders(ui) {
  return render(
    <ToastProvider>
      <TimerProvider>{ui}</TimerProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(trackEvent).mockClear();
});

describe('AgendaTab', () => {
  describe('roles that need picking (#91)', () => {
    const importSimple = async (user, text) => {
      await user.click(screen.getByRole('button', { name: /import text/i }));
      await user.click(screen.getByRole('button', { name: 'Simple Format' }));
      await user.click(screen.getByRole('textbox'));
      await user.paste(text);
      await user.click(screen.getByRole('button', { name: /^import$/i }));
    };
    const row = (name) => screen.getByText(name, { selector: '.font-medium' }).closest('[data-needs-role], div.flex');
    const savedAgenda = () => JSON.parse(localStorage.getItem('toastmaster_agenda'));
    const banner = () => screen.queryByText(/a role\. Nothing was guessed/);

    it('highlights lines whose role is not one of yours, and says how many', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await importSimple(user, 'David Kim (Table Topics Speech)\nAlex (Table Topics)\nBob');

      expect(await screen.findByText('Imported 3 speaker(s). 2 need a role')).toBeInTheDocument();
      expect(banner()).toHaveTextContent('2 rows need a role');
      expect(row('David Kim')).not.toHaveAttribute('data-needs-role');
      expect(screen.getByText('(Table Topics Speech)')).toBeInTheDocument();
      expect(row('Alex')).toHaveAttribute('data-needs-role', 'true');
      expect(screen.getByText('(Table Topics) is not one of your roles')).toBeInTheDocument();
      expect(row('Bob')).toHaveAttribute('data-needs-role', 'true');
      expect(screen.getByText('No role given')).toBeInTheDocument();
    });

    it('keeps the plain toast when every line matched', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await importSimple(user, 'Ana (ice breaker)\nBen (Standard Speech)');

      expect(await screen.findByText('Imported 2 speaker(s)')).toBeInTheDocument();
      expect(banner()).not.toBeInTheDocument();
    });

    it('sets the picked role and its rules, and clears the highlight', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);
      await importSimple(user, 'Alex (Table Topics)');

      await user.selectOptions(screen.getByRole('combobox', { name: 'Pick a role for Alex' }), 'Table Topics Speech');

      expect(row('Alex')).not.toHaveAttribute('data-needs-role');
      expect(screen.getByText('(Table Topics Speech)')).toBeInTheDocument();
      expect(banner()).not.toBeInTheDocument();
      expect(savedAgenda()[0]).toMatchObject({
        name: 'Alex',
        role: 'Table Topics Speech',
        rules: { green: 60, yellow: 90, red: 120 },
      });
    });

    it('asks for a role instead of opening the Live tab', async () => {
      const user = userEvent.setup();
      const onSwitchToLive = vi.fn();
      renderWithProviders(<AgendaTab onSwitchToLive={onSwitchToLive} />);
      await importSimple(user, 'Alex (Table Topics)');

      await user.click(screen.getByText('Alex'));

      expect(onSwitchToLive).not.toHaveBeenCalled();
      expect(await screen.findByText('Pick a role for Alex first')).toBeInTheDocument();
    });

    it('starts the Edit modal on "Pick a role…" and only saves once one is picked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);
      await importSimple(user, 'Alex (Table Topics)');

      await user.click(screen.getByRole('button', { name: 'Edit Alex' }));
      const modal = screen.getByText('Edit Speaker').closest('.bg-white');
      const select = within(modal).getByRole('combobox');
      expect(select).toHaveValue('');
      expect(within(modal).getByRole('button', { name: /^update$/i })).toBeDisabled();

      await user.selectOptions(select, 'Short Roles');
      await user.click(within(modal).getByRole('button', { name: /^update$/i }));

      expect(row('Alex')).not.toHaveAttribute('data-needs-role');
      expect(savedAgenda()[0]).toMatchObject({ role: 'Short Roles', rules: { green: 30, yellow: 45, red: 60 } });
    });

    it('highlights a row saved earlier with a role that is not listed, but not a completed one', () => {
      localStorage.setItem('toastmaster_agenda', JSON.stringify([
        { id: '1', name: 'Old', role: 'Table Topics', completed: false },
        { id: '2', name: 'Done', role: 'Table Topics', completed: true },
      ]));
      renderWithProviders(<AgendaTab />);

      expect(row('Old')).toHaveAttribute('data-needs-role', 'true');
      expect(row('Done')).not.toHaveAttribute('data-needs-role');
      expect(banner()).toHaveTextContent('1 row needs a role');
    });

    it('highlights a row whose role was removed in Edit Rules', () => {
      localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify(['Ice Breaker']));
      localStorage.setItem('toastmaster_agenda', JSON.stringify([
        { id: '1', name: 'Sam', role: 'Ice Breaker', completed: false },
      ]));
      renderWithProviders(<AgendaTab />);

      expect(row('Sam')).toHaveAttribute('data-needs-role', 'true');
      expect(screen.getByText('(Ice Breaker) is not one of your roles')).toBeInTheDocument();
    });

    it('starts Add Item on the first listed role when Standard Speech is hidden', async () => {
      localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify(['Standard Speech']));
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));
      expect(screen.getByRole('combobox')).toHaveValue('Short Roles');
      await user.type(screen.getByPlaceholderText(/enter speaker name/i), 'Kai');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      expect(row('Kai')).not.toHaveAttribute('data-needs-role');
    });

    it('imports (Take a Break) as a break, which never needs a role', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await importSimple(user, 'Coffee (Take a Break)');

      expect(await screen.findByText('Imported 1 speaker(s)')).toBeInTheDocument();
      expect(row('Coffee')).not.toHaveAttribute('data-needs-role');
      expect(savedAgenda()[0]).toMatchObject({ role: 'Take a Break', rules: { countdown: true, red: 600 } });
    });

    it('records the pick in analytics', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);
      await importSimple(user, 'Alex (Table Topics)');

      await user.selectOptions(screen.getByRole('combobox', { name: 'Pick a role for Alex' }), 'Table Topics Speech');

      expect(trackEvent).toHaveBeenCalledWith('agenda_role_picked', { is_custom: false });
    });
  });
});
