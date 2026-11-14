import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PeriodicPrompts from './PeriodicPrompts';
import { trackEvent } from '../utils/posthog';
import {
  PRO_LAUNCH_PROMPT,
  forcePrompt,
  loadPromptState,
  recordSpeechFinished,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';

// Stubbed rather than imported: the real modules pull in @zoom/appssdk, which
// hangs vitest under jsdom, and the timer context needs the whole app.
vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../context/TimerContext', () => ({ useTimerTick: () => ({ isRunning: false }) }));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// What is under test is the hand-off, not the purchase flow behind it.
vi.mock('./UpgradeModal', () => ({
  default: ({ onClose, source }) => (
    <div role="dialog" aria-label="Upgrade">
      <span>Upgrade from {source}</span>
      <button onClick={onClose}>Close upgrade</button>
    </div>
  ),
}));

// Long enough to cover SHOW_DELAY_MS in PeriodicPrompts.
const PAST_DELAY_MS = 5000;
const PRO = { plan: 'pro', status: 'active', entitled: true, source: 'subscription' };

const announcement = () => screen.queryByRole('dialog', { name: /new: pro for your club/i });

function finishSpeeches(count) {
  act(() => {
    for (let i = 0; i < count; i += 1) recordSpeechFinished();
  });
}

function afterDelay() {
  act(() => vi.advanceTimersByTime(PAST_DELAY_MS));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  localStorage.clear();
  resetEntitlementForTests();
  resetFlagsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Pro launch announcement', () => {
  it('shows after the first finished speech once Pro is released, for a free device', async () => {
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    render(<PeriodicPrompts />);

    finishSpeeches(1);
    // Held back until the delay elapses, so it never lands on the FINISH click.
    expect(announcement()).not.toBeInTheDocument();

    afterDelay();
    await waitFor(() => expect(announcement()).toBeInTheDocument());
    expect(screen.getByText(/one plan covers every timer in your club/i)).toBeInTheDocument();
    expect(loadPromptState().prompts[PRO_LAUNCH_PROMPT].asks).toBe(1);
    expect(trackEvent).toHaveBeenCalledWith('periodic_prompt_shown', { prompt: PRO_LAUNCH_PROMPT });
  });

  it.each([
    ['Pro is not released', { plan: 'free' }, { pro: false }],
    ['the device is already Pro', PRO, { pro: true }],
    ['the plan has not loaded yet', null, { pro: true }],
    ['the flags have not loaded yet', { plan: 'free' }, undefined],
  ])('stays away while %s', (_label, plan, flags) => {
    if (plan) setEntitlement(plan);
    if (flags !== undefined) setFlags(flags);
    render(<PeriodicPrompts />);

    finishSpeeches(1);
    afterDelay();

    expect(announcement()).not.toBeInTheDocument();
    expect(loadPromptState().prompts[PRO_LAUNCH_PROMPT].asks).toBe(0);
  });

  it('is shown once: closing it retires it for good', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    render(<PeriodicPrompts />);

    finishSpeeches(1);
    afterDelay();
    await waitFor(() => expect(announcement()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /not now/i }));
    expect(announcement()).not.toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('periodic_prompt_dismissed', { prompt: PRO_LAUNCH_PROMPT });

    finishSpeeches(50);
    afterDelay();
    expect(announcement()).not.toBeInTheDocument();
    expect(loadPromptState().prompts[PRO_LAUNCH_PROMPT].asks).toBe(1);
  });

  it('hands off to the Upgrade dialog and counts that as answered', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setEntitlement({ plan: 'free' });
    setFlags({ pro: true });
    render(<PeriodicPrompts />);

    finishSpeeches(1);
    afterDelay();
    await waitFor(() => expect(announcement()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /see what's in pro/i }));
    expect(trackEvent).toHaveBeenCalledWith('pro_launch_learn_more');
    await waitFor(() => expect(screen.getByText('Upgrade from pro_launch')).toBeInTheDocument());
    expect(announcement()).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close upgrade/i }));
    expect(screen.queryByText('Upgrade from pro_launch')).not.toBeInTheDocument();
    expect(loadPromptState().prompts[PRO_LAUNCH_PROMPT].resolution).toBe('answered');
    expect(trackEvent).toHaveBeenCalledWith('periodic_prompt_answered', { prompt: PRO_LAUNCH_PROMPT });
  });

  it('can be forced from the debug panel whatever the gates say', async () => {
    render(<PeriodicPrompts />);

    act(() => forcePrompt(PRO_LAUNCH_PROMPT));

    await waitFor(() => expect(announcement()).toBeInTheDocument());
    expect(loadPromptState().prompts[PRO_LAUNCH_PROMPT].asks).toBe(0);
  });
});
