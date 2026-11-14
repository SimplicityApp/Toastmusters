import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgendaTab from './AgendaTab';
import { renderWithProviders } from '../test/helpers';

describe('AgendaTab', () => {
  describe('empty state', () => {
    it('shows "No speakers in agenda" message', () => {
      renderWithProviders(<AgendaTab />);
      expect(screen.getByText(/no speakers in agenda/i)).toBeInTheDocument();
    });

    it('renders the Import Text button', () => {
      renderWithProviders(<AgendaTab />);
      expect(
        screen.getByRole('button', { name: /import text/i })
      ).toBeInTheDocument();
    });

    it('renders the Add Item button', () => {
      renderWithProviders(<AgendaTab />);
      expect(
        screen.getByRole('button', { name: /add item/i })
      ).toBeInTheDocument();
    });

    it('does NOT render a Clear All button when the agenda is empty', () => {
      renderWithProviders(<AgendaTab />);
      expect(
        screen.queryByRole('button', { name: /clear all/i })
      ).not.toBeInTheDocument();
    });
  });

  describe('Add Item modal', () => {
    it('opens the Add Speaker modal when Add Item is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));

      expect(screen.getByText('Add Speaker')).toBeInTheDocument();
    });

    it('shows a name input field inside the modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));

      expect(
        screen.getByPlaceholderText(/enter speaker name/i)
      ).toBeInTheDocument();
    });

    it('shows a role dropdown inside the modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));

      // There may be multiple comboboxes; the modal one should be inside the modal dialog
      const selects = screen.getAllByRole('combobox');
      expect(selects.length).toBeGreaterThan(0);
    });

    it('shows Add and Cancel buttons inside the modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));

      expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('closes the modal when Cancel is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));
      expect(screen.getByText('Add Speaker')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByText('Add Speaker')).not.toBeInTheDocument();
    });

    it('adds a speaker and shows them in the list after clicking Add', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));

      const nameInput = screen.getByPlaceholderText(/enter speaker name/i);
      await user.type(nameInput, 'Charlie');

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => {
        expect(screen.getByText('Charlie')).toBeInTheDocument();
      });

      // Modal should be closed after adding
      expect(screen.queryByText('Add Speaker')).not.toBeInTheDocument();
    });

    it('shows Clear All button after at least one speaker is added', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await user.click(screen.getByRole('button', { name: /add item/i }));
      await user.type(screen.getByPlaceholderText(/enter speaker name/i), 'Dana');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /clear all/i })).toBeInTheDocument();
      });
    });
  });

  describe('editing a speaker', () => {
    const addSpeaker = async (user, name) => {
      await user.click(screen.getByRole('button', { name: /add item/i }));
      await user.type(screen.getByPlaceholderText(/enter speaker name/i), name);
      await user.click(screen.getByRole('button', { name: /^add$/i }));
      await waitFor(() => {
        expect(screen.getByText(name)).toBeInTheDocument();
      });
    };

    it('keeps the speaker in their original position after a name change', async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgendaTab />);

      await addSpeaker(user, 'Alice');
      await addSpeaker(user, 'Bob');
      await addSpeaker(user, 'Carol');

      await user.click(screen.getByRole('button', { name: 'Edit Bob' }));
      const nameInput = screen.getByPlaceholderText(/enter speaker name/i);
      await user.clear(nameInput);
      await user.type(nameInput, 'Bobby');
      await user.click(screen.getByRole('button', { name: /^update$/i }));

      await waitFor(() => {
        expect(screen.getByText('Bobby')).toBeInTheDocument();
      });
      const order = screen
        .getAllByRole('button', { name: /^edit /i })
        .map((btn) => btn.getAttribute('aria-label').replace('Edit ', ''));
      expect(order).toEqual(['Alice', 'Bobby', 'Carol']);
    });
  });

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
  });

  describe('switching to live tab', () => {
    it('calls onSwitchToLive when a speaker item is clicked', async () => {
      const user = userEvent.setup();
      const onSwitchToLive = vi.fn();
      renderWithProviders(<AgendaTab onSwitchToLive={onSwitchToLive} />);

      // Add a speaker first
      await user.click(screen.getByRole('button', { name: /add item/i }));
      await user.type(screen.getByPlaceholderText(/enter speaker name/i), 'Eve');
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => {
        expect(screen.getByText('Eve')).toBeInTheDocument();
      });

      // Click the speaker row to load into live tab
      await user.click(screen.getByText('Eve'));

      expect(onSwitchToLive).toHaveBeenCalledTimes(1);
    });
  });
});
