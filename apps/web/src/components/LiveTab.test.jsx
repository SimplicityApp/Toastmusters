import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LiveTab from './LiveTab';
import { renderWithProviders } from '../test/helpers';
import { useEffect } from 'react';
import { useTimer } from '../context/TimerContext';

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
