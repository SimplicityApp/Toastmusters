import '@testing-library/jest-dom';
import { act, render } from '@testing-library/react';
import ContactCapture, { SHOW_DELAY_MS } from './ContactCapture';
import { useTimerTick } from '../context/TimerContext';
import { useFlag } from '../hooks/useFlag';
import { resolveZoomIdentity } from '../utils/zoomIdentity';
import { attempt, writeCaptureState } from '../utils/contactCapture';
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

const advance = (ms) => act(() => { vi.advanceTimersByTime(ms); });

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
    expect(attempt).toHaveBeenCalledWith('auto', session());
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
  // never repeated for them (the card itself arrives in a later phase).
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
