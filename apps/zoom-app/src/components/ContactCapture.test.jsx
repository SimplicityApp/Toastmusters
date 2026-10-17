import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ContactCapture, { SHOW_DELAY_MS } from './ContactCapture';
import { useTimerTick } from '../context/TimerContext';
import { useFlag } from '../hooks/useFlag';
import { resolveZoomIdentity } from '../utils/zoomIdentity';
import { CAPTURE_BACKOFF_MS, attempt, readCaptureState, writeCaptureState } from '../utils/contactCapture';
import { trackEvent } from '../utils/posthog';
import { isApiAvailable } from '../utils/zoomSdk';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom. The eligibility rules themselves stay real.
vi.mock('../utils/zoomSdk', () => ({
  isApiAvailable: vi.fn(),
  requestZoomAuthorizeCode: vi.fn(),
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../context/TimerContext', () => ({ useTimerTick: vi.fn() }));
vi.mock('../hooks/useFlag', () => ({ useFlag: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({ resolveZoomIdentity: vi.fn() }));
vi.mock('../utils/contactCapture', async (importOriginal) => ({
  ...(await importOriginal()),
  attempt: vi.fn(),
}));

const session = (over = {}) => ({ identified: true, uid: 'uid-1', token: 'tok-1', contactKnown: false, ...over });

let running = false;
function setRunning(value, rerender) {
  running = value;
  rerender(<ContactCapture />);
}

/** Render, and let the identity promise settle. */
async function renderCapture() {
  const utils = render(<ContactCapture />);
  await act(async () => {});
  return utils;
}

// Async so the promise an elapsed timer starts (attempt) settles inside act.
const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  running = false;
  useTimerTick.mockImplementation(() => ({ isRunning: running }));
  useFlag.mockReturnValue({ enabled: true, known: true });
  resolveZoomIdentity.mockResolvedValue(session());
  isApiAvailable.mockReturnValue(true);
  attempt.mockResolvedValue('saved');
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ContactCapture', () => {
  it('renders nothing', async () => {
    const { container } = await renderCapture();
    expect(container).toBeEmptyDOMElement();
  });

  it('asks once the timer has been idle for the grace period', async () => {
    await renderCapture();

    await advance(SHOW_DELAY_MS - 1);
    expect(attempt).not.toHaveBeenCalled();

    await advance(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith('auto', session(), { onLateSaved: expect.any(Function) });
  });

  // Zoom's consent screen must never land on a live speech.
  it('waits while a speech is being timed, and restarts the grace when it ends', async () => {
    running = true;
    const { rerender } = await renderCapture();

    await advance(SHOW_DELAY_MS * 4);
    expect(attempt).not.toHaveBeenCalled();

    setRunning(false, rerender);
    await advance(SHOW_DELAY_MS - 1);
    // A new speech inside the grace cancels it.
    setRunning(true, rerender);
    await advance(SHOW_DELAY_MS * 2);
    expect(attempt).not.toHaveBeenCalled();

    setRunning(false, rerender);
    await advance(SHOW_DELAY_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('asks only once per load, however often the timer goes idle', async () => {
    attempt.mockResolvedValue('failed');
    const { rerender } = await renderCapture();
    await advance(SHOW_DELAY_MS);

    setRunning(true, rerender);
    setRunning(false, rerender);
    await advance(SHOW_DELAY_MS * 3);

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a user who is not eligible', async () => {
    const cases = [
      () => resolveZoomIdentity.mockResolvedValue(session({ contactKnown: true })),
      () => resolveZoomIdentity.mockResolvedValue(session({ identified: false, uid: null, token: null })),
      () => useFlag.mockReturnValue({ enabled: false, known: true }),
      () => isApiAvailable.mockReturnValue(false),
      () => writeCaptureState('uid-1', { mode: 'auto', nextAt: Date.now() + 60_000 }),
    ];
    for (const setUp of cases) {
      setUp();
      const { unmount } = await renderCapture();
      await advance(SHOW_DELAY_MS * 2);
      expect(attempt).not.toHaveBeenCalled();
      unmount();
      // Back to an eligible baseline for the next case.
      localStorage.clear();
      resolveZoomIdentity.mockResolvedValue(session());
      useFlag.mockReturnValue({ enabled: true, known: true });
      isApiAvailable.mockReturnValue(true);
    }
  });

  // A user who skipped Zoom's screen is in card mode; the automatic attempt is
  // never repeated for them.
  it('does not ask automatically again after a skip', async () => {
    writeCaptureState('uid-1', { mode: 'card', nextAt: 0 });
    await renderCapture();
    await advance(SHOW_DELAY_MS * 2);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('asks as soon as the flag turns on while idle', async () => {
    useFlag.mockReturnValue({ enabled: false, known: false });
    const { rerender } = await renderCapture();
    await advance(SHOW_DELAY_MS * 2);
    expect(attempt).not.toHaveBeenCalled();

    useFlag.mockReturnValue({ enabled: true, known: true });
    rerender(<ContactCapture />);
    await advance(SHOW_DELAY_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('ContactCapture card', () => {
  const card = () => screen.queryByRole('region', { name: /stay in touch/i });
  const inCardMode = (nextAt = 0) => writeCaptureState('uid-1', { mode: 'card', nextAt });

  it('never shows in auto mode', async () => {
    attempt.mockResolvedValue('failed');
    await renderCapture();
    await advance(SHOW_DELAY_MS * 3);
    expect(card()).toBeNull();
  });

  it('shows in card mode once the timer has been idle for the grace period', async () => {
    inCardMode();
    await renderCapture();

    await advance(SHOW_DELAY_MS - 1);
    expect(card()).toBeNull();

    await advance(1);
    expect(card()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve in Zoom' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(card()).toHaveTextContent(/opt out of these emails at any time/i);
  });

  it('shows at the next idle moment after the automatic ask is skipped', async () => {
    attempt.mockImplementation(async () => {
      writeCaptureState('uid-1', { mode: 'card', nextAt: Date.now() });
      return 'skipped';
    });
    await renderCapture();
    await advance(SHOW_DELAY_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();

    await advance(SHOW_DELAY_MS);
    expect(card()).toBeInTheDocument();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  // Never in the way of a speech: down the moment one starts, back after it.
  it('hides when a speech starts and comes back after the next grace', async () => {
    inCardMode();
    const { rerender } = await renderCapture();
    await advance(SHOW_DELAY_MS);
    expect(card()).toBeInTheDocument();

    setRunning(true, rerender);
    expect(card()).toBeNull();
    await advance(SHOW_DELAY_MS * 2);
    expect(card()).toBeNull();

    setRunning(false, rerender);
    await advance(SHOW_DELAY_MS - 1);
    expect(card()).toBeNull();
    await advance(1);
    expect(card()).toBeInTheDocument();
  });

  it('does not show while a backoff runs or for an ineligible user', async () => {
    const cases = [
      () => inCardMode(Date.now() + 60_000),
      () => {
        inCardMode();
        resolveZoomIdentity.mockResolvedValue(session({ contactKnown: true }));
      },
      () => {
        inCardMode();
        useFlag.mockReturnValue({ enabled: false, known: true });
      },
      () => {
        inCardMode();
        isApiAvailable.mockReturnValue(false);
      },
    ];
    for (const setUp of cases) {
      setUp();
      const { unmount } = await renderCapture();
      await advance(SHOW_DELAY_MS * 2);
      expect(card()).toBeNull();
      unmount();
      localStorage.clear();
      resolveZoomIdentity.mockResolvedValue(session());
      useFlag.mockReturnValue({ enabled: true, known: true });
      isApiAvailable.mockReturnValue(true);
    }
  });

  it('"Not now" snoozes for seven days and keeps the card away on reopen', async () => {
    inCardMode();
    const { unmount } = await renderCapture();
    await advance(SHOW_DELAY_MS);

    const before = Date.now();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(card()).toBeNull();
    expect(readCaptureState('uid-1')).toEqual({ mode: 'card', nextAt: before + CAPTURE_BACKOFF_MS });
    expect(trackEvent).toHaveBeenCalledWith('contact_capture_dismissed', { source: 'card' });
    expect(attempt).not.toHaveBeenCalled();

    unmount();
    await renderCapture();
    await advance(SHOW_DELAY_MS * 3);
    expect(card()).toBeNull();
  });

  it('the close button snoozes like "Not now"', async () => {
    inCardMode();
    await renderCapture();
    await advance(SHOW_DELAY_MS);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(card()).toBeNull();
    expect(readCaptureState('uid-1').nextAt).toBeGreaterThan(Date.now());
  });

  it('"Approve in Zoom" runs the card attempt and takes the card down when it is done', async () => {
    inCardMode();
    let finish;
    attempt.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await renderCapture();
    await advance(SHOW_DELAY_MS);

    fireEvent.click(screen.getByRole('button', { name: 'Approve in Zoom' }));

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith('card', session(), { onLateSaved: expect.any(Function) });
    // Zoom's screen is up: no second ask, no dismissal underneath it.
    expect(screen.getByRole('button', { name: 'Approve in Zoom' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();

    await act(async () => { finish('saved'); });
    expect(card()).toBeNull();

    await advance(SHOW_DELAY_MS * 3);
    expect(card()).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stays down for the rest of the load after a card attempt is skipped again', async () => {
    inCardMode();
    attempt.mockImplementation(async () => {
      writeCaptureState('uid-1', { mode: 'card', nextAt: Date.now() + CAPTURE_BACKOFF_MS });
      return 'skipped';
    });
    const { rerender } = await renderCapture();
    await advance(SHOW_DELAY_MS);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve in Zoom' }));
    });
    expect(card()).toBeNull();

    setRunning(true, rerender);
    setRunning(false, rerender);
    await advance(SHOW_DELAY_MS * 3);
    expect(card()).toBeNull();
  });

  // A code that lands after Zoom's 2-minute wait is still saved; the card the
  // skip brought up then has nothing left to ask.
  it('comes down when a late code is saved', async () => {
    let onLateSaved;
    attempt.mockImplementation(async (_source, _session, options) => {
      onLateSaved = options.onLateSaved;
      writeCaptureState('uid-1', { mode: 'card', nextAt: Date.now() });
      return 'skipped';
    });
    await renderCapture();
    await advance(SHOW_DELAY_MS);
    await advance(SHOW_DELAY_MS);
    expect(card()).toBeInTheDocument();

    await act(async () => {
      writeCaptureState('uid-1', null);
      onLateSaved();
    });

    expect(card()).toBeNull();
    await advance(SHOW_DELAY_MS * 3);
    expect(card()).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
