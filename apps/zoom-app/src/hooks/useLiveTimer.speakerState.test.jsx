import { render, act } from '@testing-library/react';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider, useTimer, useTimerTick } from '../context/TimerContext';
import { useLiveTimer } from './useLiveTimer';
import { BREAK_ROLE, DEFAULT_ROLE_RULES } from '@toastmaster-timer/shared';

// Same stub as useLiveTimer.test.jsx: the real module pulls in @zoom/appssdk,
// which hangs vitest under jsdom.
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

/**
 * #168, what the speaker model must keep beyond the oracle: the Timer tab
 * unmounts on every tab switch (App.jsx, b/NewLookShell.jsx) while the timer
 * context stays, so a staged edit and the row let go of for a quick timing must
 * survive a trip to the Agenda or Report tab. START keeps a staged edit too, and
 * "Back to agenda" never resets a quick timing in progress.
 */

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

const out = {};
function TimerView() {
  out.t = useLiveTimer();
  return null;
}
function Shell({ tab }) {
  out.ctx = useTimer();
  out.tick = useTimerTick();
  return tab === 'live' ? <TimerView /> : null;
}
const tree = (tab) => (
  <ToastProvider>
    <TimerProvider>
      <Shell tab={tab} />
    </TimerProvider>
  </ToastProvider>
);

function setup() {
  localStorage.setItem('toastmaster_agenda', JSON.stringify(SEED));
  const view = render(tree('live'));
  /** Away to another tab: the Timer tab unmounts, the timer context stays. */
  const away = () => {
    view.rerender(tree('agenda'));
    out.t = null;
  };
  const back = () => view.rerender(tree('live'));
  const switchTabs = () => {
    away();
    back();
  };
  return { away, back, switchTabs };
}
const run = (fn) => act(() => fn());
const names = () => out.ctx.agenda.map((item) => item.name);

describe('useLiveTimer: speaker state across tab switches and START (#168)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an edit staged for Update through a tab switch, and Update still writes it', () => {
    const { switchTabs } = setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleSpeakerChange('Dana'));
    run(() => out.t.handleRoleChange(TT));

    switchTabs();

    expect(out.t.speakerName).toBe('Dana');
    expect(out.t.selectedRole).toBe(TT);
    expect(out.t.speakerEntry.labelsFor().unsaved).toBe('Unsaved changes');
    run(() => out.t.handleCommitSpeakerName());
    expect(out.ctx.agenda[1]).toMatchObject({ id: 'b', name: 'Dana', role: TT, rules: RULES[TT] });
  });

  it('drops a staged edit when another row was loaded meanwhile', () => {
    const { away, back } = setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleSpeakerChange('Dana'));
    away();
    // The Agenda tab's own load button, while the Timer tab is away.
    run(() => out.ctx.loadSpeakerFromAgenda('c'));
    back();

    expect(out.t.speakerName).toBe('Cole');
    expect(out.t.speakerEntry.labelsFor().unsaved).toBeNull();
  });

  it('keeps the row let go of for a quick timing through a tab switch: Back to agenda and Save still use it', () => {
    vi.useFakeTimers();
    const { switchTabs } = setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleSwitchToQuickTiming());
    run(() => out.t.handleSpeakerChange('Guest'));
    run(() => out.t.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    run(() => out.t.handleFinish());

    // A look at the Report, then back.
    switchTabs();

    expect(out.ctx.reports.at(-1)).toMatchObject({ name: 'Guest' });
    expect(out.t.speakerEntry.labelsFor().backToAgenda).toBe('Back to agenda');
    run(() => out.t.handleSpeakerChange('Eve'));
    run(() => out.t.handleSaveToAgenda());
    expect(names()).toEqual(['Ana', 'Jordan', 'Eve', 'Cole']);
  });

  it('START keeps an edit staged for Update, times the speaker as loaded, and the rules line and stage say the clock\'s role', () => {
    vi.useFakeTimers();
    setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleRoleChange(TT));
    expect(out.t.roleOnClock).toBe('Ice Breaker');
    expect(out.t.roleExplanation).toBe('Green: 4 minutes, Yellow: 5 minutes, Red: 6 minutes');

    run(() => out.t.handleStart());
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(out.ctx.currentSpeaker).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(out.ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: 'Ice Breaker' });
    expect(out.t.selectedRole).toBe(TT);
    expect(out.t.speakerEntry.labelsFor().update).toBe('Update Jordan on the agenda');

    run(() => out.t.handleUpdate());
    expect(out.ctx.agenda[1]).toMatchObject({ name: 'Jordan', role: TT, rules: RULES[TT] });
    expect(out.t.roleOnClock).toBe(TT);
    expect(out.t.roleExplanation).toBe('Green: 1 minute, Yellow: 1 min 30 sec, Red: 2 minutes');
    // Update changed the rules, not the speech: still timing.
    expect(out.tick.isRunning).toBe(true);
  });

  it('picking the loaded row from the list again drops a staged edit', () => {
    setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleSpeakerChange('Dana'));
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    expect(out.t.speakerName).toBe('Jordan');
    expect(out.t.speakerEntry.labelsFor().unsaved).toBeNull();
  });

  it('Back to agenda does nothing while the quick timing is running or paused', () => {
    vi.useFakeTimers();
    setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleSwitchToQuickTiming());
    run(() => out.t.handleSpeakerChange('Guest'));
    run(() => out.t.handleStart());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(out.t.speakerEntry.labelsFor().backToAgenda).toBeNull();

    run(() => out.t.handleBackToAgenda());
    expect(out.ctx.activeSpeakerId).toBeNull();
    expect(out.tick.isRunning).toBe(true);

    run(() => out.t.handleStop());
    run(() => out.t.handleBackToAgenda());
    expect(out.ctx.activeSpeakerId).toBeNull();
    expect(out.tick.elapsedTime).toBeGreaterThan(0);
  });

  it('never adds a name that is already on the agenda', () => {
    setup();
    run(() => out.t.handleSelectAgendaSpeaker('b'));
    run(() => out.t.handleAddSpeaker('cole', TT));
    expect(names()).toEqual(['Ana', 'Jordan', 'Cole']);
    expect(out.ctx.activeSpeakerId).toBe('b');
  });

  it('starts the add panel on the default role during a break, not on the break', () => {
    setup();
    run(() => out.t.handleRoleChange(BREAK_ROLE));
    expect(out.ctx.currentSpeaker.role).toBe(BREAK_ROLE);
    expect(out.t.speakerEntry.clockRole).toBe('Standard Speech');
  });
});
