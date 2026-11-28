import { render, renderHook, act } from '@testing-library/react';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider, useTimer, useTimerTick } from '../context/TimerContext';
import { useLiveTimer } from './useLiveTimer';
import { applyOverlay, clearVideoPipelines, isOverlayActive, removeOverlay } from '../utils/zoomSdk';
import { BREAK_ROLE, DEFAULT_ROLE_RULES } from '@toastmaster-timer/shared';

// Same stub as LiveTab.test.jsx: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({
  getVideoState: vi.fn().mockResolvedValue(null),
  setVideoState: vi.fn(),
  applyOverlay: vi.fn(),
  removeOverlay: vi.fn(),
  clearVideoPipelines: vi.fn().mockResolvedValue({ ok: true, declined: false, ungranted: [], lostBackground: false }),
  isOverlayActive: vi.fn(() => false),
  getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
  getSdkStatus: vi.fn(() => ({ initialized: true, available: false, sdkExists: false, missingApis: [], apiCount: 0 })),
  setLogCallback: vi.fn(),
  getOverlayMode: vi.fn(() => 'camera'),
  setOverlayMode: vi.fn().mockResolvedValue(undefined),
  getOverlayTimePosition: vi.fn(() => ({ x: 0.18, y: 0.3 })),
  setOverlayTimePosition: vi.fn(),
  getOverlayTimeScale: vi.fn(() => 0.18),
  setOverlayTimeScale: vi.fn((scale) => scale),
  isOverlayTimeVisible: vi.fn(() => true),
  setOverlayTimeVisible: vi.fn(),
  setOverlayTimeLabel: vi.fn(),
  setPopoutChangeCallback: vi.fn(),
  setShareChangeCallback: vi.fn(),
  setAppShare: vi.fn(),
  setAppPopout: vi.fn(),
  isAppShareActive: vi.fn(() => false),
  isAppPoppedOut: vi.fn(() => false),
  isVideoOverlayMode: vi.fn(() => true),
  getClubBadgePlacement: vi.fn(() => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true })),
  setClubBadgePlacement: vi.fn((patch) => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true, ...patch })),
  resetClubBadgePlacement: vi.fn(() => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true })),
  isClubBadgeMoved: vi.fn(() => false),
  getZoomParticipants: vi.fn().mockResolvedValue({ participants: [], role: 'host', restricted: false }),
  OVERLAY_MODE_CARD: 'card',
  OVERLAY_MODE_CAMERA: 'camera',
  OVERLAY_MODE_STAGE: 'stage',
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));

const wrapper = ({ children }) => (
  <ToastProvider>
    <TimerProvider>{children}</TimerProvider>
  </ToastProvider>
);

/**
 * LiveTab.test.jsx proves the hook through today's panel. This proves the part
 * the redesigned panel relies on: a view with no markup of LiveTab's gets the
 * same timer and the same video behaviour from the hook alone.
 */
describe('useLiveTimer', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // Reveal between speeches, so idle means "nothing of ours on the video".
    localStorage.setItem('toastmaster_reveal_face_when_idle', 'true');
  });

  it('runs the timer for any view that calls it', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLiveTimer(), { wrapper });
      expect(result.current.isRunning).toBe(false);

      act(() => result.current.handleStart());
      expect(result.current.isRunning).toBe(true);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.elapsedTime).toBeGreaterThanOrEqual(2);

      act(() => result.current.handleStop());
      expect(result.current.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('owns the video: the colour goes on at Start, and comes off when a reset ends the speech', async () => {
    const { result } = renderHook(() => useLiveTimer(), { wrapper });
    expect(applyOverlay).not.toHaveBeenCalled();

    act(() => result.current.handleStart());
    expect(applyOverlay).toHaveBeenCalledWith('/backgrounds/blue.png');

    act(() => result.current.handleStop());
    isOverlayActive.mockReturnValue(true);
    await act(async () => {
      await result.current.handleReset();
    });
    expect(result.current.elapsedTime).toBe(0);
    // Reveals on: Reset hands the video back through the same path as the eraser.
    expect(clearVideoPipelines).toHaveBeenCalledTimes(1);
  });

  it('hands both looks the same set of controls', () => {
    const { result } = renderHook(() => useLiveTimer(), { wrapper });
    for (const handler of [
      'handleStart', 'handleStop', 'handleContinue', 'handleReset', 'handleFinish',
      'handleSpeakerChange', 'handleRoleChange', 'handleSelectSuggestion', 'handleAddSpeaker',
      'handleModeSwitch', 'handleClearVideo', 'handlePreviewColor', 'handleTurnVideoOn',
      'handleReadoutPositionChange', 'handleBadgePlacementChange', 'handleToggleRevealFaceWhenIdle',
    ]) {
      expect(typeof result.current[handler], handler).toBe('function');
    }
  });
});

/**
 * #168, on-the-spot speakers: the one speaker model both looks draw (the old
 * look's panel and stage, and design B). Named as in the plan:
 *
 *   handleSpeakerChange(name), handleRoleChange(role)   with a row loaded these only
 *                                                        stage an edit; in quick timing
 *                                                        they label the clock, as today
 *   handleUpdate() / handleUndo()                        write / drop the staged edit
 *   handleAddSpeaker(name, role)                         the add panel
 *   handleSwitchToQuickTiming() / handleBackToAgenda()   let go of the row / load it again
 *   handleSaveToAgenda()                                 put a quick-timed name on the agenda
 *
 * Asserted through the timer context (the agenda, the loaded row, the clock's
 * speaker, the report), which is what every view and the Agenda tab read.
 */
describe('useLiveTimer: on-the-spot speakers (#168)', () => {
  const RULES = {
    'Standard Speech': DEFAULT_ROLE_RULES['Standard Speech'],
    'Ice Breaker': DEFAULT_ROLE_RULES['Ice Breaker'],
    'Table Topics Speech': DEFAULT_ROLE_RULES['Table Topics Speech'],
  };
  const SEED = [
    { id: 'a', name: 'Ana', role: 'Standard Speech', rules: RULES['Standard Speech'], completed: false },
    { id: 'b', name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'], completed: false },
    { id: 'c', name: 'Cole', role: 'Standard Speech', rules: RULES['Standard Speech'], completed: false },
  ];
  const TT = 'Table Topics Speech';
  const names = (r) => r.current.ctx.agenda.map((item) => item.name);
  const row = (r, name) => r.current.ctx.agenda.find((item) => item.name === name);

  /** Calls a handler the plan names, failing on an assertion when it is missing. */
  const call = (r, name, ...args) => {
    expect(typeof r.current.t[name], `useLiveTimer returns ${name}()`).toBe('function');
    act(() => {
      r.current.t[name](...args);
    });
  };

  function setup({ insertPosition } = {}) {
    localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
    if (insertPosition) localStorage.setItem('toastmaster_speaker_insert_position', insertPosition);
    const view = renderHook(() => ({ t: useLiveTimer(), ctx: useTimer(), tick: useTimerTick() }), { wrapper });
    return { r: view.result, unmount: view.unmount };
  }

  const loadJordan = (r) => call(r, 'handleSelectAgendaSpeaker', 'b');

  // Each test starts from an empty store: AC-2/AC-3 set "at the end", which must not
  // carry into the tests that expect the default "right after".
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-1: a speaker added after the loaded row is inserted there and loaded, under their own rules', () => {
    const { r } = setup();
    loadJordan(r);

    call(r, 'handleAddSpeaker', 'Dana', TT);

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(r.current.ctx.activeSpeakerId).toBe(row(r, 'Dana').id);
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
  });

  it('AC-2: with the setting on "at the end", the speaker goes last and is loaded', () => {
    const { r } = setup({ insertPosition: 'end' });
    loadJordan(r);

    call(r, 'handleAddSpeaker', 'Dana', TT);

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
    expect(r.current.ctx.activeSpeakerId).toBe(row(r, 'Dana').id);
  });

  it('AC-3: with nothing loaded and nothing let go of, the speaker goes last, whichever setting is on', () => {
    for (const insertPosition of ['afterActive', 'end']) {
      localStorage.clear();
      const { r, unmount } = setup({ insertPosition });

      call(r, 'handleAddSpeaker', 'Dana', TT);

      expect(names(r), insertPosition).toEqual(['Ana', 'Jordan', 'Cole', 'Dana']);
      unmount();
    }
  });

  it('AC-6: a name change is staged: nothing moves until Update, then the row is renamed in place', () => {
    const { r } = setup();
    loadJordan(r);

    call(r, 'handleSpeakerChange', 'Dana');
    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(r.current.ctx.currentSpeaker.name).toBe('Jordan');

    call(r, 'handleUpdate');
    expect(names(r)).toEqual(['Ana', 'Dana', 'Cole']);
    expect(r.current.ctx.agenda[1].id).toBe('b');
    expect(r.current.ctx.activeSpeakerId).toBe('b');
    expect(r.current.ctx.currentSpeaker.name).toBe('Dana');
  });

  it('AC-6: Undo changes puts both fields back, and saves nothing', () => {
    const { r } = setup();
    loadJordan(r);
    call(r, 'handleSpeakerChange', 'Dana');
    call(r, 'handleRoleChange', TT);

    call(r, 'handleUndo');
    expect(r.current.t.speakerName).toBe('Jordan');
    expect(r.current.t.selectedRole).toBe('Ice Breaker');

    // Nothing left to write.
    call(r, 'handleUpdate');
    expect(r.current.ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker' });
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-9: a role change is staged with the name, and Update writes both and the rules to the row and the clock', () => {
    const { r } = setup();
    loadJordan(r);

    call(r, 'handleSpeakerChange', 'Dana');
    call(r, 'handleRoleChange', TT);
    expect(r.current.ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });

    call(r, 'handleUpdate');
    expect(r.current.ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT, rules: RULES[TT] });
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
    expect(r.current.ctx.activeSpeakerId).toBe('b');
  });

  it('AC-9: choosing Take a Break still lets go of the row at once and leaves it untouched', () => {
    const { r } = setup();
    loadJordan(r);

    call(r, 'handleRoleChange', BREAK_ROLE);

    expect(r.current.ctx.activeSpeakerId).toBeNull();
    expect(r.current.ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker', completed: false });
  });

  it('AC-13: adding during a speech inserts but leaves the timer, its label and the video alone; FINISH moves to them', () => {
    vi.useFakeTimers();
    const { r } = setup();
    loadJordan(r);
    call(r, 'handleStart');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const elapsed = r.current.tick.elapsedTime;
    expect(elapsed).toBeGreaterThan(0);
    applyOverlay.mockClear();
    removeOverlay.mockClear();

    call(r, 'handleAddSpeaker', 'Dana', TT);

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(r.current.ctx.activeSpeakerId).toBe('b');
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
    expect(r.current.tick.isRunning).toBe(true);
    expect(r.current.tick.elapsedTime).toBeGreaterThanOrEqual(elapsed);
    expect(applyOverlay).not.toHaveBeenCalled();
    expect(removeOverlay).not.toHaveBeenCalled();

    call(r, 'handleFinish');
    expect(r.current.ctx.activeSpeakerId).toBe(row(r, 'Dana').id);
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Dana', role: TT, rules: RULES[TT] });
  });

  it('AC-13: a paused speech counts as in progress too', () => {
    vi.useFakeTimers();
    const { r } = setup();
    loadJordan(r);
    call(r, 'handleStart');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    call(r, 'handleStop');
    const elapsed = r.current.tick.elapsedTime;

    call(r, 'handleAddSpeaker', 'Dana', TT);

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Dana', 'Cole']);
    expect(r.current.ctx.activeSpeakerId).toBe('b');
    expect(r.current.tick.elapsedTime).toBe(elapsed);
  });

  it('AC-14: quick timing lets go of the row, the name labels the clock, FINISH reports it and the agenda is unchanged', () => {
    vi.useFakeTimers();
    const { r } = setup();
    loadJordan(r);

    call(r, 'handleSwitchToQuickTiming');
    expect(r.current.ctx.activeSpeakerId).toBeNull();
    expect(r.current.ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', completed: false });

    call(r, 'handleSpeakerChange', 'Guest');
    expect(r.current.ctx.currentSpeaker.name).toBe('Guest');
    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole']);

    call(r, 'handleStart');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    call(r, 'handleFinish');

    expect(r.current.ctx.reports.at(-1)).toMatchObject({ name: 'Guest' });
    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(r.current.ctx.agenda.every((item) => !item.completed)).toBe(true);
  });

  it('AC-14: Back to agenda loads the row that was let go of', () => {
    const { r } = setup();
    loadJordan(r);
    call(r, 'handleSwitchToQuickTiming');
    expect(r.current.ctx.activeSpeakerId).toBeNull();

    call(r, 'handleBackToAgenda');

    expect(r.current.ctx.activeSpeakerId).toBe('b');
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker', rules: RULES['Ice Breaker'] });
  });

  it('AC-15: a quick-timed name is saved after the row let go of, with the role shown, and loaded', () => {
    const { r } = setup();
    loadJordan(r);
    call(r, 'handleSwitchToQuickTiming');
    call(r, 'handleSpeakerChange', 'Eve');
    const shownRole = r.current.t.selectedRole;

    call(r, 'handleSaveToAgenda');

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Eve', 'Cole']);
    expect(row(r, 'Eve').role).toBe(shownRole);
    expect(r.current.ctx.activeSpeakerId).toBe(row(r, 'Eve').id);
  });

  it('AC-15: with no row let go of, the saved name goes last', () => {
    const { r } = setup();
    call(r, 'handleSpeakerChange', 'Eve');

    call(r, 'handleSaveToAgenda');

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole', 'Eve']);
    expect(r.current.ctx.activeSpeakerId).toBe(row(r, 'Eve').id);
  });

  it('AC-15: saved during a speech, the name is inserted but not loaded', () => {
    vi.useFakeTimers();
    const { r } = setup();
    call(r, 'handleSpeakerChange', 'Eve');
    call(r, 'handleStart');
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    call(r, 'handleSaveToAgenda');

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole', 'Eve']);
    expect(r.current.ctx.activeSpeakerId).toBeNull();
    expect(r.current.tick.isRunning).toBe(true);
  });

  it('AC-16: START never adds or changes an agenda row', () => {
    vi.useFakeTimers();
    const { r } = setup();
    // A quick timing with a typed name.
    call(r, 'handleSpeakerChange', 'Guest');
    call(r, 'handleStart');
    expect(names(r)).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(r.current.ctx.activeSpeakerId).toBeNull();
    call(r, 'handleStop');
    act(() => {
      r.current.t.handleReset();
    });

    // A loaded row with a staged rename.
    loadJordan(r);
    call(r, 'handleSpeakerChange', 'Dana');
    call(r, 'handleStart');
    expect(r.current.ctx.agenda).toHaveLength(3);
    expect(r.current.ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Jordan', role: 'Ice Breaker' });
  });

  it('AC-11: the shared sequence ends on the same agenda and clock as every other surface', () => {
    vi.useFakeTimers();
    const { r } = setup();
    loadJordan(r);
    call(r, 'handleAddSpeaker', 'Dana', TT);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    call(r, 'handleSpeakerChange', 'Dane');
    call(r, 'handleUpdate');
    call(r, 'handleSwitchToQuickTiming');
    call(r, 'handleSpeakerChange', 'Eve');
    act(() => {
      vi.advanceTimersByTime(10);
    });
    call(r, 'handleSaveToAgenda');

    expect(names(r)).toEqual(['Ana', 'Jordan', 'Dane', 'Eve', 'Cole']);
    expect(r.current.ctx.agenda.map((item) => item.role)).toEqual([
      'Standard Speech', 'Ice Breaker', TT, TT, 'Standard Speech',
    ]);
    expect(r.current.ctx.activeSpeakerId).toBe(row(r, 'Eve').id);
    expect(r.current.ctx.currentSpeaker).toMatchObject({ name: 'Eve', role: TT, rules: RULES[TT] });
  });
});

/**
 * Both looks unmount the timer tab on a tab switch, and the hook seeds its name
 * field from the shared speaker when the tab comes back. Seen in the Zoom client
 * on 2026-11-19: after Finish the speaker who had just finished came back, and
 * Start timed them again under their name.
 */
describe('useLiveTimer after a tab switch', () => {
  /** The hook in a tab that unmounts and remounts under one provider, as App renders it. */
  function renderRemountable() {
    const live = { current: null };
    const timer = { current: null };
    function TimerTab() {
      live.current = useLiveTimer();
      timer.current = useTimer();
      return null;
    }
    const tree = (showTab) => (
      <ToastProvider>
        <TimerProvider>{showTab && <TimerTab />}</TimerProvider>
      </ToastProvider>
    );
    const view = render(tree(true));
    const switchTabs = () => {
      view.rerender(tree(false));
      view.rerender(tree(true));
    };
    return { live, timer, switchTabs };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // The tick is rAF-driven, and Finish records nothing that never ran.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no name after a Finish with nobody next, and keeps the role', () => {
    const { live, switchTabs } = renderRemountable();
    act(() => live.current.handleRoleChange('Ice Breaker'));
    act(() => live.current.handleSpeakerChange('Priya'));
    act(() => live.current.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => live.current.handleFinish());
    expect(live.current.speakerName).toBe('');

    act(() => switchTabs());

    expect(live.current.speakerName).toBe('');
    expect(live.current.currentSpeaker).toMatchObject({ name: '', role: 'Ice Breaker' });
    expect(live.current.selectedRole).toBe('Ice Breaker');
  });

  it('starts with no name after a Reset', async () => {
    const { live, switchTabs } = renderRemountable();
    act(() => live.current.handleSpeakerChange('Priya'));
    act(() => live.current.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => live.current.handleStop());
    await act(async () => {
      await live.current.handleReset();
    });
    expect(live.current.speakerName).toBe('');

    act(() => switchTabs());

    expect(live.current.speakerName).toBe('');
    expect(live.current.currentSpeaker.name).toBe('');
  });

  it('lets go of the agenda row on Reset, so the next Finish ticks nothing off', async () => {
    // A name cleared with the row still linked: the next Start was reported
    // with no name, and its Finish ticked Priya off and loaded whoever was next.
    const { live, switchTabs } = renderRemountable();
    act(() => live.current.handleAddSpeaker('Priya'));
    const priyaId = live.current.activeSpeakerId;
    expect(priyaId).toBeTruthy();
    act(() => live.current.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => live.current.handleStop());
    await act(async () => {
      await live.current.handleReset();
    });

    expect(live.current.activeSpeakerId).toBeNull();
    act(() => switchTabs());
    expect(live.current.speakerName).toBe('');

    act(() => live.current.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => live.current.handleFinish());
    expect(live.current.agenda.find((item) => item.id === priyaId).completed).toBe(false);
  });

  it('shows rules edited during a pause once Reset ends that speech', async () => {
    const edited = { green: 240, yellow: 270, red: 300, graceAfterRed: 30 };
    const { live, timer } = renderRemountable();
    act(() => live.current.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => live.current.handleStop());
    act(() => timer.current.updateRoleRules('Standard Speech', edited));
    // Paused: the speech keeps the rules it started with.
    expect(live.current.currentSpeaker.rules).not.toEqual(edited);

    await act(async () => {
      await live.current.handleReset();
    });

    expect(live.current.currentSpeaker.rules).toEqual(edited);
  });
});
