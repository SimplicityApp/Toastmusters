import { renderHook, act } from '@testing-library/react';
import { ToastProvider } from './ToastContext';
import { TimerProvider, useTimer, useTimerTick } from './TimerContext';
import { applyOverlay, removeOverlay, isOverlayActive, setOverlayTimeLabel, getBackgroundUrl } from '../utils/zoomSdk';
import { BREAK_ROLE, deriveBreakRules } from '@toastmaster-timer/shared';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  applyOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  getBackgroundUrl: vi.fn(() => '/backgrounds/blue.png'),
  isOverlayActive: vi.fn(() => false),
  getOverlayMode: vi.fn(() => 'card'),
  isVideoOverlayMode: vi.fn(() => true),
  setOverlayTimeLabel: vi.fn(),
  OVERLAY_MODE_CARD: 'card',
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

function wrapper({ children }) {
  return (
    <ToastProvider>
      <TimerProvider>{children}</TimerProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('addToAgenda', () => {
  it('can make the new speaker current in the same tick it is added', () => {
    // The old shape — add, then loadSpeakerFromAgenda(id) — read the agenda
    // from the render the callback was created in, which cannot contain the new
    // item. Nothing happened, so the speaker was on the agenda but not active.
    const { result } = renderHook(() => useTimer(), { wrapper });

    let id;
    act(() => {
      id = result.current.addToAgenda({ name: 'Priya', role: 'Standard Speech' }, { activate: true });
    });

    expect(result.current.activeSpeakerId).toBe(id);
    expect(result.current.currentSpeaker?.name).toBe('Priya');
    expect(result.current.agenda.map((item) => item.name)).toEqual(['Priya']);
  });

  it('renames that speaker in place rather than adding a second one', () => {
    // What "Enter to rename" depends on: without the activation above there is
    // no active item, so correcting the name reads as a new speaker.
    const { result } = renderHook(() => useTimer(), { wrapper });

    let id;
    act(() => {
      id = result.current.addToAgenda({ name: 'Jon', role: 'Standard Speech' }, { activate: true });
    });
    act(() => {
      result.current.renameAgendaSpeaker(id, 'Jonathan');
    });

    expect(result.current.agenda.map((item) => item.name)).toEqual(['Jonathan']);
    expect(result.current.currentSpeaker?.name).toBe('Jonathan');
  });

  it('leaves the current speaker alone without activate', () => {
    // The agenda tab adds rows without moving the timer off whoever is speaking.
    const { result } = renderHook(() => useTimer(), { wrapper });

    act(() => {
      result.current.addToAgenda({ name: 'Priya', role: 'Standard Speech' });
    });

    expect(result.current.activeSpeakerId).toBeNull();
    expect(result.current.currentSpeaker).toBeNull();
    expect(result.current.agenda).toHaveLength(1);
  });
});

describe('resetTimer', () => {
  it('leaves the video alone with skipVideo, whatever is on it', () => {
    // How the RESET button gets a stripped tile: LiveTab clears both pipelines
    // itself, outside the overlay queue. A push or a removal from here as well
    // would race that clear — and in camera mode the loser is a confirmation
    // dialog for a background that has already gone.
    isOverlayActive.mockReturnValue(true);
    const { result } = renderHook(() => ({ ...useTimer(), ...useTimerTick() }), { wrapper });

    act(() => {
      result.current.resetTimer({ skipVideo: true });
    });

    expect(applyOverlay).not.toHaveBeenCalled();
    expect(removeOverlay).not.toHaveBeenCalled();
    expect(result.current.elapsedTime).toBe(0);
    expect(result.current.currentStatus).toBe('blue');
  });

  it('still returns the card to blue without the option', () => {
    // Every other caller — a speaker change, a role change — keeps the old
    // behavior: reveal-when-idle is off by default, so the color stays up.
    isOverlayActive.mockReturnValue(true);
    const { result } = renderHook(() => useTimer(), { wrapper });

    act(() => {
      result.current.resetTimer();
    });

    expect(applyOverlay).toHaveBeenCalledWith('/backgrounds/blue.png');
    expect(removeOverlay).not.toHaveBeenCalled();
  });
});

describe('Take a Break and the agenda', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an ad-hoc break consumes no agenda slot, and the agenda still advances after it', () => {
    // Real timers cannot drive the rAF tick in a test; fake ones can, and the
    // finish flow refuses to record a session that never accumulated time.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
    });
    const { result } = renderHook(() => ({ timer: useTimer(), tick: useTimerTick() }), { wrapper });

    let aliceId;
    act(() => {
      aliceId = result.current.timer.addToAgenda({ name: 'Alice', role: 'Standard Speech' }, { activate: true });
    });
    // Agenda ids come from Date.now(), which fake timers freeze; step past it
    // so Bob does not collide with Alice.
    act(() => { vi.advanceTimersByTime(10); });
    let bobId;
    act(() => {
      bobId = result.current.timer.addToAgenda({ name: 'Bob', role: 'Standard Speech' });
    });

    // What the Live tab does when the organizer switches the role to Take a
    // Break while Alice is loaded: the break replaces her as the current
    // session and detaches from her agenda slot.
    act(() => {
      result.current.timer.setCurrentSpeaker({ name: '', role: BREAK_ROLE, rules: deriveBreakRules(180) });
      result.current.timer.clearActiveSpeaker();
    });

    act(() => { result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.tick.elapsedTime).toBeGreaterThan(0);
    act(() => { result.current.timer.finishCurrentSpeech(); });

    // The break went to the report, judgment-free...
    expect(result.current.timer.reports.at(-1)).toMatchObject({
      role: BREAK_ROLE,
      disqualified: false,
      comments: '',
    });
    // ...but nobody's slot was consumed by it.
    expect(result.current.timer.agenda.find((i) => i.id === aliceId).completed).toBe(false);
    expect(result.current.timer.agenda.find((i) => i.id === bobId).completed).toBe(false);

    // And the break blocks nothing afterwards: Alice loads, speaks, and
    // completes her slot exactly as if the break had never happened.
    act(() => { result.current.timer.loadSpeakerFromAgenda(aliceId); });
    expect(result.current.timer.activeSpeakerId).toBe(aliceId);
    act(() => { result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { result.current.timer.finishCurrentSpeech(); });
    expect(result.current.timer.agenda.find((i) => i.id === aliceId).completed).toBe(true);
    expect(result.current.timer.agenda.find((i) => i.id === bobId).completed).toBe(false);
  });
});

describe('surviving a webview teardown', () => {
  // Zoom kills the webview when the app is closed; a remount is what the app
  // sees when it is reopened. Fake timers make Date.now deterministic, which is
  // what the saved start timestamp is measured against.
  const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'];

  afterEach(() => {
    vi.useRealTimers();
  });

  function mount() {
    return renderHook(() => ({ timer: useTimer(), tick: useTimerTick() }), { wrapper });
  }

  it('boots idle and pushes nothing when no session was saved', () => {
    // The baseline every other behavior here rests on: a normal start of the
    // app is exactly as it was — no overlay, no readout, no toast.
    const { result } = mount();

    expect(result.current.tick.isRunning).toBe(false);
    expect(result.current.tick.elapsedTime).toBe(0);
    expect(result.current.timer.currentSpeaker).toBeNull();
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(setOverlayTimeLabel).not.toHaveBeenCalled();
    expect(localStorage.getItem('toastmaster_timer_session')).toBeNull();
  });

  it('a running speech picks up at the wall-clock elapsed after a remount', () => {
    vi.useFakeTimers({ toFake: FAKE });
    const first = mount();
    let id;
    act(() => {
      id = first.result.current.timer.addToAgenda({ name: 'Alice', role: 'Standard Speech' }, { activate: true });
    });
    act(() => { first.result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(first.result.current.tick.elapsedTime).toBeCloseTo(3, 1);
    first.unmount();
    vi.clearAllMocks();

    // Closed for five seconds — the clock kept going without us.
    act(() => { vi.advanceTimersByTime(5000); });
    const second = mount();

    expect(second.result.current.tick.isRunning).toBe(true);
    expect(second.result.current.tick.elapsedTime).toBeCloseTo(8, 1);
    expect(second.result.current.timer.currentSpeaker).toMatchObject({ name: 'Alice', role: 'Standard Speech' });
    expect(second.result.current.timer.activeSpeakerId).toBe(id);
    // The tile is repainted: a fresh webview has pushed nothing yet.
    expect(setOverlayTimeLabel).toHaveBeenCalledWith('00:08');
    expect(applyOverlay).toHaveBeenCalledTimes(1);

    // And it keeps ticking from there rather than from zero.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(second.result.current.tick.elapsedTime).toBeCloseTo(10, 1);
  });

  it('restores the color a threshold crossed while the app was closed', () => {
    vi.useFakeTimers({ toFake: FAKE });
    const first = mount();
    act(() => {
      first.result.current.timer.setCurrentSpeaker({ name: 'Bo', role: 'Custom', rules: { green: 5, yellow: 10, red: 15 } });
    });
    act(() => { first.result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(first.result.current.tick.currentStatus).toBe('blue');
    first.unmount();
    vi.clearAllMocks();
    getBackgroundUrl.mockImplementation((color) => `/backgrounds/${color}.png`);

    act(() => { vi.advanceTimersByTime(11000); });
    const second = mount();

    expect(second.result.current.tick.currentStatus).toBe('yellow');
    expect(applyOverlay).toHaveBeenCalledWith('/backgrounds/yellow.png');
  });

  it('a paused speech comes back paused at the same elapsed', () => {
    vi.useFakeTimers({ toFake: FAKE });
    const first = mount();
    act(() => {
      first.result.current.timer.setCurrentSpeaker({ name: 'Cy', role: 'Standard Speech' });
    });
    act(() => { first.result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { first.result.current.timer.stopTimer(); });
    first.unmount();

    // Time passing while paused is not speaking time.
    act(() => { vi.advanceTimersByTime(60000); });
    const second = mount();

    expect(second.result.current.tick.isRunning).toBe(false);
    expect(second.result.current.tick.elapsedTime).toBeCloseTo(4, 1);
    // Continue carries on from four, not from zero.
    act(() => { second.result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(second.result.current.tick.elapsedTime).toBeCloseTo(5, 1);
  });

  it('finishing, resetting, or changing speaker leaves nothing to restore', () => {
    vi.useFakeTimers({ toFake: FAKE });
    const key = 'toastmaster_timer_session';
    const { result, unmount } = mount();
    act(() => {
      result.current.timer.setCurrentSpeaker({ name: 'Di', role: 'Standard Speech' });
    });

    act(() => { result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(localStorage.getItem(key)).not.toBeNull();
    act(() => { result.current.timer.finishCurrentSpeech(); });
    expect(localStorage.getItem(key)).toBeNull();

    // A paused speech being reset is the case the persistence effect cannot
    // see on its own: isRunning was already false.
    act(() => { result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { result.current.timer.stopTimer(); });
    expect(localStorage.getItem(key)).not.toBeNull();
    act(() => { result.current.timer.resetTimer({ skipVideo: true }); });
    expect(localStorage.getItem(key)).toBeNull();

    // Picking another speaker resets the timer, and the record with it.
    act(() => { result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => {
      result.current.timer.setCurrentSpeaker({ name: 'Ed', role: 'Standard Speech' });
    });
    expect(localStorage.getItem(key)).toBeNull();

    unmount();
    const fresh = mount();
    expect(fresh.result.current.tick.elapsedTime).toBe(0);
    expect(fresh.result.current.timer.currentSpeaker).toBeNull();
  });

  it('a name corrected mid-speech is the name that comes back', () => {
    vi.useFakeTimers({ toFake: FAKE });
    const first = mount();
    act(() => {
      first.result.current.timer.setCurrentSpeaker({ name: 'Jon', role: 'Standard Speech' });
    });
    act(() => { first.result.current.timer.startTimer(); });
    act(() => { first.result.current.timer.updateSpeakerName('Jonathan'); });
    first.unmount();

    const second = mount();
    expect(second.result.current.timer.currentSpeaker?.name).toBe('Jonathan');
  });

  it('ignores a session left over from an earlier meeting', () => {
    // Without this, yesterday's forgotten timer would boot the app straight
    // into a red card on the organizer's face.
    vi.useFakeTimers({ toFake: FAKE });
    const first = mount();
    act(() => {
      first.result.current.timer.setCurrentSpeaker({ name: 'Old', role: 'Standard Speech' });
    });
    act(() => { first.result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(1000); });
    first.unmount();
    vi.clearAllMocks();

    act(() => { vi.advanceTimersByTime(2 * 60 * 60 * 1000); });
    const second = mount();

    expect(second.result.current.tick.isRunning).toBe(false);
    expect(second.result.current.tick.elapsedTime).toBe(0);
    expect(second.result.current.timer.currentSpeaker).toBeNull();
    expect(applyOverlay).not.toHaveBeenCalled();
  });

  it('drops the agenda link when that item is gone, but keeps the speech', () => {
    vi.useFakeTimers({ toFake: FAKE });
    const first = mount();
    let id;
    act(() => {
      id = first.result.current.timer.addToAgenda({ name: 'Gone', role: 'Standard Speech' }, { activate: true });
    });
    act(() => { first.result.current.timer.startTimer(); });
    act(() => { vi.advanceTimersByTime(1000); });
    first.unmount();
    // The agenda changed underneath the saved link — another device, say.
    localStorage.removeItem('toastmaster_agenda');

    const second = mount();
    expect(second.result.current.tick.isRunning).toBe(true);
    expect(second.result.current.timer.currentSpeaker?.name).toBe('Gone');
    expect(second.result.current.timer.activeSpeakerId).toBeNull();
    expect(id).toBeDefined();
  });

  it('ignores a malformed record', () => {
    localStorage.setItem('toastmaster_timer_session', '{"running":true,"speaker":{}}');
    const { result } = mount();
    expect(result.current.tick.isRunning).toBe(false);
    expect(result.current.timer.currentSpeaker).toBeNull();
    expect(applyOverlay).not.toHaveBeenCalled();
  });
});
