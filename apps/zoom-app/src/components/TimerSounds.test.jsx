import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  BREAK_ROLE,
  resetEntitlementForTests,
  resetFlagsForTests,
  resetSoundSettingsForTests,
  setEntitlement,
  setFlags,
  updateSoundSettings,
} from '@toastmaster-timer/shared';
import TimerSounds from './TimerSounds';
import SoundsModal from './SoundsModal';
import { soundEngine } from '../hooks/useSounds';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

const timer = { tick: { currentStatus: 'blue', isRunning: false }, speaker: null };
vi.mock('../context/TimerContext', () => ({
  useTimerTick: () => timer.tick,
  useTimer: () => ({ currentSpeaker: timer.speaker }),
}));

const PRO = { plan: 'pro', status: 'active', entitled: true, source: 'subscription' };

function setTimer(tick, speaker = timer.speaker) {
  timer.tick = { ...timer.tick, ...tick };
  timer.speaker = speaker;
}

beforeEach(() => {
  localStorage.clear();
  resetEntitlementForTests();
  resetFlagsForTests();
  resetSoundSettingsForTests();
  setTimer({ currentStatus: 'blue', isRunning: false }, { name: 'Ann', role: 'Standard Speech' });
  vi.spyOn(soundEngine, 'playCue').mockReturnValue(true);
  vi.spyOn(soundEngine, 'startMusic').mockReturnValue(true);
  vi.spyOn(soundEngine, 'stopMusic').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

/** Render, then walk the timer through statuses, re-rendering each step. */
function runThrough(statuses, { isRunning = true } = {}) {
  const view = render(<TimerSounds />);
  setTimer({ isRunning });
  view.rerender(<TimerSounds />);
  for (const currentStatus of statuses) {
    setTimer({ currentStatus });
    view.rerender(<TimerSounds />);
  }
  return view;
}

describe('the card-change chime', () => {
  it('chimes each card for a Pro user who turned it on', () => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    updateSoundSettings({ cues: true, volume: 0.5 });
    runThrough(['green', 'yellow', 'red']);
    expect(soundEngine.playCue.mock.calls).toEqual([
      ['green', 0.5],
      ['yellow', 0.5],
      ['red', 0.5],
    ]);
  });

  it('stays quiet when turned off', () => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    runThrough(['green', 'yellow']);
    expect(soundEngine.playCue).not.toHaveBeenCalled();
  });

  it('stays quiet for a free user, even with the setting saved on', () => {
    setFlags({ sounds: true });
    setEntitlement({ plan: 'free' });
    updateSoundSettings({ cues: true });
    runThrough(['green']);
    expect(soundEngine.playCue).not.toHaveBeenCalled();
  });

  it('stays quiet while the flag is off', () => {
    setFlags({ sounds: false });
    setEntitlement(PRO);
    updateSoundSettings({ cues: true });
    runThrough(['green']);
    expect(soundEngine.playCue).not.toHaveBeenCalled();
  });

  it('does not chime on a reset back to blue', () => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    updateSoundSettings({ cues: true });
    runThrough(['green', 'blue']);
    expect(soundEngine.playCue).toHaveBeenCalledTimes(1);
  });
});

describe('break music', () => {
  beforeEach(() => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    updateSoundSettings({ music: true });
  });

  it('plays while a break runs and stops at 00:00', () => {
    setTimer({}, { name: '', role: BREAK_ROLE });
    const view = runThrough(['green']);
    expect(soundEngine.startMusic).toHaveBeenCalledWith('music-box', expect.any(Number));
    soundEngine.stopMusic.mockClear();
    setTimer({ currentStatus: 'red' });
    view.rerender(<TimerSounds />);
    expect(soundEngine.stopMusic).toHaveBeenCalled();
  });

  it('does not play for a speech', () => {
    runThrough(['green']);
    expect(soundEngine.startMusic).not.toHaveBeenCalled();
  });

  it('stops when the break is paused', () => {
    setTimer({}, { name: '', role: BREAK_ROLE });
    const view = runThrough(['green']);
    soundEngine.stopMusic.mockClear();
    setTimer({ isRunning: false });
    view.rerender(<TimerSounds />);
    expect(soundEngine.stopMusic).toHaveBeenCalled();
  });
});

describe('the Sounds modal', () => {
  it('lets a Pro user turn the chime on', () => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    render(<SoundsModal isOpen onClose={() => {}} />);
    const chime = screen.getByRole('checkbox', { name: /chime when the card changes/i });
    expect(chime).not.toBeChecked();
    fireEvent.click(chime);
    expect(chime).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /play the yellow chime/i }));
    expect(soundEngine.playCue).toHaveBeenCalledWith('yellow', expect.any(Number));
  });

  it('locks the controls for a free user and says why', () => {
    setFlags({ sounds: true, pro: true });
    setEntitlement({ plan: 'free' });
    render(<SoundsModal isOpen onClose={() => {}} />);
    expect(screen.getByRole('checkbox', { name: /chime when the card changes/i })).toBeDisabled();
    expect(screen.getByText(/sounds are a pro feature/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade to pro/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Locked')).toBeInTheDocument();
    expect(document.querySelector('[data-tooltip]')).toHaveAttribute(
      'data-tooltip',
      'Sounds are a Pro feature. Upgrade to Pro to use them.',
    );
  });

  it('opens locked for a Pro user while sounds are unreleased, without selling Pro', () => {
    setFlags({ sounds: false, pro: true });
    setEntitlement(PRO);
    render(<SoundsModal isOpen onClose={() => {}} />);
    expect(screen.getByRole('checkbox', { name: /chime when the card changes/i })).toBeDisabled();
    expect(screen.getByText(/sounds are coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade to pro/i })).toBeNull();
  });

  it('shows no lock to a Pro user once sounds are released', () => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    render(<SoundsModal isOpen onClose={() => {}} />);
    expect(screen.queryByLabelText('Locked')).toBeNull();
    expect(document.querySelector('[data-tooltip]')).toBeNull();
  });

  it('shows no lock before the flag and plan answers arrive', () => {
    render(<SoundsModal isOpen onClose={() => {}} />);
    expect(screen.getByRole('checkbox', { name: /chime when the card changes/i })).toBeDisabled();
    expect(screen.queryByLabelText('Locked')).toBeNull();
  });

  it('offers no Upgrade link while Pro is unreleased', () => {
    setFlags({ sounds: true, pro: false });
    setEntitlement({ plan: 'free' });
    render(<SoundsModal isOpen onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /upgrade to pro/i })).toBeNull();
  });

  it('stops a music preview on close', () => {
    setFlags({ sounds: true });
    setEntitlement(PRO);
    const onClose = vi.fn();
    render(<SoundsModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /preview music/i }));
    expect(soundEngine.startMusic).toHaveBeenCalled();
    act(() => fireEvent.click(screen.getByRole('button', { name: /close/i })));
    expect(soundEngine.stopMusic).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
