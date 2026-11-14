import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveTab from './LiveTab';
import { renderWithProviders } from '../test/helpers';
import { useEffect } from 'react';
import { useTimer } from '../context/TimerContext';
import { trackEvent } from '../utils/posthog';
import { DEFAULT_ROLE_RULES } from '@toastmaster-timer/shared';

describe('LiveTab', () => {
  describe('initial state', () => {
    it('renders the START button', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
      });
    });

    it('renders the RESET button', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
      });
    });

    it('renders the speaker name input', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText(/type speaker name/i)
        ).toBeInTheDocument();
      });
    });

    it('renders the role selector', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });
    });

    it('defaults the role selector to "Standard Speech"', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        expect(select).toHaveValue('Standard Speech');
      });
    });

    it('shows the timer display at 00:00', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        expect(screen.getByText('00:00')).toBeInTheDocument();
      });
    });

    it('does not show STOP or FINISH buttons initially', async () => {
      renderWithProviders(<LiveTab />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^finish$/i })).not.toBeInTheDocument();
    });
  });

  describe('starting the timer', () => {
    it('hides START button and shows STOP and FINISH after clicking START', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LiveTab />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /start/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument();
    });

    it('calls onTimerStart prop when START is clicked', async () => {
      const user = userEvent.setup();
      const onTimerStart = vi.fn();
      renderWithProviders(<LiveTab onTimerStart={onTimerStart} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /start/i }));

      await waitFor(() => {
        expect(onTimerStart).toHaveBeenCalledTimes(1);
      });
    });

    // #107: the web timer has no Zoom meeting to count, so reach falls back to
    // one per start. A guessed audience_size here would inflate it.
    it('sends timer_started without audience_size', async () => {
      const user = userEvent.setup();
      trackEvent.mockClear();
      renderWithProviders(<LiveTab />);

      await user.click(await screen.findByRole('button', { name: /start/i }));

      await waitFor(() => {
        expect(trackEvent).toHaveBeenCalledWith('timer_started', expect.anything());
      });
      const calls = trackEvent.mock.calls.filter(([name]) => name === 'timer_started');
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ role: 'Standard Speech' });
      expect(calls[0][1]).not.toHaveProperty('audience_size');
    });
  });

  describe('stopping the timer', () => {
    it('shows CONTINUE button after clicking STOP once the timer has elapsed', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LiveTab />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
      });

      // Start the timer
      await user.click(screen.getByRole('button', { name: /start/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
      });

      // Allow the real interval to tick at least once (100ms per tick)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });

      // Stop the timer — elapsedTime should now be > 0 so CONTINUE appears
      await user.click(screen.getByRole('button', { name: /stop/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument();
    });

    it('calls onTimerStart prop when CONTINUE is clicked', async () => {
      const user = userEvent.setup();
      const onTimerStart = vi.fn();
      renderWithProviders(<LiveTab onTimerStart={onTimerStart} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start/i })).toBeInTheDocument();
      });

      // Start (1st call)
      await user.click(screen.getByRole('button', { name: /start/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
      });

      // Let the timer tick so CONTINUE appears (not START) after STOP
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });

      await user.click(screen.getByRole('button', { name: /stop/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
      });

      // Continue (2nd call) — this is the bug regression
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(onTimerStart).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('role selection', () => {
    it('changes the selected role when a different option is chosen', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LiveTab />);

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      const select = screen.getByRole('combobox');
      await user.selectOptions(select, 'Ice Breaker');

      expect(select).toHaveValue('Ice Breaker');
    });
  });

  describe('speaker name input', () => {
    it('allows typing a speaker name', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LiveTab />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type speaker name/i)).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/type speaker name/i);
      await user.type(input, 'Jane');

      expect(input).toHaveValue('Jane');
    });
  });
});

describe('LiveTab "Time this" deep link', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('loads the role and name from the URL and then strips them', async () => {
    window.history.pushState({}, '', '/timer/app?role=Table%20Topics%20Speech&name=Describe%20a%20perfect%20day');
    renderWithProviders(<LiveTab />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('Table Topics Speech');
    });
    expect(screen.getByPlaceholderText(/type speaker name/i)).toHaveValue('Describe a perfect day');
    expect(window.location.pathname).toBe('/timer/app');
    expect(window.location.search).toBe('');
  });

  it('falls back to the defaults for an unknown role and still strips the params', async () => {
    window.history.pushState({}, '', '/timer/app?role=Keynote&name=Jane');
    renderWithProviders(<LiveTab />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('Standard Speech');
    });
    expect(screen.getByPlaceholderText(/type speaker name/i)).toHaveValue('');
    expect(window.location.search).toBe('');
  });

  it('does not override a speaker the context already has', async () => {
    // Stands in for a speaker restored before the Live tab mounts: LiveTab is
    // only rendered once the context holds one.
    function Seeded() {
      const { currentSpeaker, setCurrentSpeaker } = useTimer();
      useEffect(() => {
        setCurrentSpeaker({ name: 'Jane', role: 'Ice Breaker' });
      }, [setCurrentSpeaker]);
      return currentSpeaker ? <LiveTab /> : null;
    }

    window.history.pushState({}, '', '/timer/app?role=Table%20Topics%20Speech&name=Describe%20a%20perfect%20day');
    renderWithProviders(<Seeded />);

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('Ice Breaker');
    });
    expect(screen.getByPlaceholderText(/type speaker name/i)).toHaveValue('Jane');
    expect(window.location.search).toBe('');
  });
});

describe('LiveTab starting role when Standard Speech is removed', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify(['Standard Speech']));
  });
  afterEach(() => localStorage.clear());

  it('starts on the first role in the list, and START times it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LiveTab />);

    expect(screen.getAllByRole('combobox')[0]).toHaveValue('Short Roles');
    await user.click(screen.getByRole('button', { name: /start/i }));

    expect(screen.queryByText('Please set timing rules first')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });
});

// #91: an imported row whose bracket named none of the user's roles keeps that
// text as its role and has no rules. The Agenda tab asks for the role; the Live
// tab's suggestions and FINISH must not load the row either, or the speaker is
// timed under a role nobody chose.
describe('LiveTab and an agenda row that needs a role (#91)', () => {
  const CHAIR = { green: 60, yellow: 90, red: 120, graceAfterRed: 30 };
  const BOB = { id: 'b1', name: 'Bob', role: 'Ice Breaker', rules: DEFAULT_ROLE_RULES['Ice Breaker'], completed: false };
  // As Simple Format import leaves "Alex (Table Topics)": no such role, no rules.
  const ALEX = { id: 'x1', name: 'Alex', role: 'Table Topics', completed: false };
  const ALICE = { id: 'a1', name: 'Alice', role: 'Standard Speech', rules: DEFAULT_ROLE_RULES['Standard Speech'], completed: false };
  const ASK_ALEX = 'Pick a role for Alex on the Agenda tab first';

  const rolePicker = () => screen.getByRole('combobox');
  const nameField = () => screen.getByPlaceholderText(/type speaker name/i);

  /** Open the suggestion list and pick an agenda speaker (selection is on mousedown). */
  function pickSuggestion(name) {
    fireEvent.focus(nameField());
    fireEvent.mouseDown(screen.getByText(name));
  }

  /** Renders the tab with a handle on the timer context, for what only it can do. */
  function renderWithTimer() {
    const handle = {};
    function Grab() {
      Object.assign(handle, useTimer());
      return null;
    }
    renderWithProviders(<><Grab /><LiveTab /></>);
    return handle;
  }

  /** START, let the clock run a few ticks, FINISH. */
  async function timeASpeech(user) {
    await user.click(screen.getByRole('button', { name: /start/i }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await user.click(screen.getByRole('button', { name: /finish/i }));
  }

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('toastmaster_agenda', JSON.stringify([BOB, ALEX, ALICE]));
  });
  afterEach(() => localStorage.clear());

  it('a speaker suggestion that needs a role does not load', async () => {
    renderWithProviders(<LiveTab />);
    await waitFor(() => expect(rolePicker()).toHaveValue('Standard Speech'));

    pickSuggestion('Alex');

    expect(await screen.findByText(ASK_ALEX)).toBeInTheDocument();
    expect(nameField()).toHaveValue('');
    // Not timed under the default role either: nothing about the speaker moved.
    expect(rolePicker()).toHaveValue('Standard Speech');

    // A row with a role still loads from the same list.
    pickSuggestion('Bob');
    expect(nameField()).toHaveValue('Bob');
    expect(rolePicker()).toHaveValue('Ice Breaker');
  });

  it('FINISH does not load a next speaker who needs a role, nor fall back to the default role', async () => {
    const user = userEvent.setup();
    const timer = renderWithTimer();
    act(() => timer.loadSpeakerFromAgenda('b1'));
    expect(rolePicker()).toHaveValue('Ice Breaker');

    await timeASpeech(user);

    expect(await screen.findByText(ASK_ALEX)).toBeInTheDocument();
    expect(nameField()).toHaveValue('');
    // Still Bob's role: neither Alex's text nor Standard Speech.
    expect(rolePicker()).toHaveValue('Ice Breaker');
    // The running order stops at Alex rather than skipping to Alice.
    expect(timer.activeSpeakerId).toBeNull();
    expect(timer.agenda.map((item) => item.completed)).toEqual([true, false, false]);
  });

  it('a hand-picked role that leaves the list still moves to the default role (e876ca8)', async () => {
    const user = userEvent.setup();
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ ChairToast1: CHAIR }));
    localStorage.setItem('toastmaster_role_order', JSON.stringify(['ChairToast1']));
    const timer = renderWithTimer();

    await user.selectOptions(rolePicker(), 'ChairToast1');
    act(() => timer.removeRoleRules('ChairToast1'));

    expect(rolePicker()).toHaveValue('Standard Speech');
    expect(screen.queryByText(/on the Agenda tab first/)).not.toBeInTheDocument();
  });

  it('lets go of a loaded agenda row whose role leaves the list, instead of re-roling it', async () => {
    const user = userEvent.setup();
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ ChairToast1: CHAIR }));
    localStorage.setItem('toastmaster_role_order', JSON.stringify(['ChairToast1']));
    localStorage.setItem('toastmaster_agenda', JSON.stringify([
      { id: 'c1', name: 'Carol', role: 'ChairToast1', rules: CHAIR, completed: false },
      BOB,
    ]));
    const timer = renderWithTimer();
    act(() => timer.loadSpeakerFromAgenda('c1'));
    expect(rolePicker()).toHaveValue('ChairToast1');

    act(() => timer.removeRoleRules('ChairToast1'));

    expect(await screen.findByText('Pick a role for Carol on the Agenda tab first')).toBeInTheDocument();
    expect(nameField()).toHaveValue('');
    expect(rolePicker()).toHaveValue('Standard Speech');
    expect(timer.activeSpeakerId).toBeNull();
    // The row keeps its role for the Agenda tab to flag; nothing re-roled it.
    expect(timer.agenda.find((item) => item.id === 'c1')).toMatchObject({ role: 'ChairToast1', completed: false });

    // A speech timed now is not Carol's: finishing it neither completes her
    // row nor advances past it to Bob.
    await timeASpeech(user);
    expect(nameField()).toHaveValue('');
    expect(timer.agenda.map((item) => item.completed)).toEqual([false, false]);
  });
});
