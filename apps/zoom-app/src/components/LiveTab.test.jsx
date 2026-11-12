import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import LiveTab from './LiveTab';
import { BREAK_ROLE, DEFAULT_ROLE_RULES, deriveBreakRules } from '@toastmaster-timer/shared';
import { applyOverlay, clearVideoPipelines, isOverlayActive, getZoomParticipants } from '../utils/zoomSdk';
import { trackEvent } from '../utils/posthog';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom. Faithful to the real return shapes, since the tab
// reads fields off several of these.
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
  getOverlayMode: vi.fn(() => 'card'),
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

function renderLive() {
  return render(
    <ToastProvider>
      <TimerProvider>
        <LiveTab />
      </TimerProvider>
    </ToastProvider>
  );
}

const nameField = () => screen.getByPlaceholderText('Type speaker name...');
const resetButton = () => screen.getByRole('button', { name: 'RESET' });

const REVEAL_KEY = 'toastmaster_reveal_face_when_idle';

/** Open the suggestion list and pick an agenda speaker by name. */
function pickFromAgenda(name) {
  // Synchronous on purpose: the agenda suggestions render straight from
  // state, and findBy* polls with timers this suite has faked. Selection is
  // on mousedown (so it beats the input's blur), not click.
  fireEvent.focus(nameField());
  fireEvent.mouseDown(screen.getByText(name));
}

/** Run the (faked) clock long enough for the finish flow to record a session. */
function runTimerFor(ms) {
  fireEvent.click(screen.getByRole('button', { name: /start|continue/i }));
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  fireEvent.click(screen.getByRole('button', { name: 'FINISH' }));
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // The tick is rAF-driven and the finish flow refuses to record a session
  // that never accumulated time, so the clock has to be fake to be drivable.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
  });
  localStorage.setItem('toastmaster_agenda', JSON.stringify([
    { id: 'a1', name: 'Alice', role: 'Standard Speech', rules: DEFAULT_ROLE_RULES['Standard Speech'], completed: false },
    { id: 'b1', name: 'Bob', role: 'Standard Speech', rules: DEFAULT_ROLE_RULES['Standard Speech'], completed: false },
  ]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('finishing and the agenda running order', () => {
  it('auto-loads the next speaker after a speech', () => {
    renderLive();
    pickFromAgenda('Alice');
    expect(nameField()).toHaveValue('Alice');

    runTimerFor(2000);

    // The running order carries on by itself: Bob is up.
    expect(nameField()).toHaveValue('Bob');
  });

  it('does not auto-load anyone after a break, and leaves the interrupted speaker\'s slot alone', () => {
    renderLive();
    pickFromAgenda('Alice');

    // The organizer calls a break instead of starting Alice's speech.
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: BREAK_ROLE } });
    runTimerFor(2000);

    // A break ending is the meeting pausing, not advancing: nobody is loaded
    // until the organizer picks the next speaker themselves.
    expect(nameField()).toHaveValue('');

    // And the break consumed nothing: Alice still loads and her slot still
    // hands over to Bob, exactly as if the break had never happened.
    pickFromAgenda('Alice');
    runTimerFor(2000);
    expect(nameField()).toHaveValue('Bob');
  });

  it('does not auto-load anyone after a break that was itself on the agenda', () => {
    // An imported agenda can carry its own break line. Finishing it keeps its
    // agenda link (the item completes), so only the finish-time guard — not
    // the ad-hoc detach — stands between it and auto-loading the next speaker.
    localStorage.setItem('toastmaster_agenda', JSON.stringify([
      { id: 'br1', name: 'Coffee break', role: BREAK_ROLE, rules: deriveBreakRules(600), completed: false },
      { id: 'b1', name: 'Bob', role: 'Standard Speech', rules: DEFAULT_ROLE_RULES['Standard Speech'], completed: false },
    ]));
    renderLive();
    pickFromAgenda('Coffee break');

    runTimerFor(2000);

    expect(nameField()).toHaveValue('');
  });
});

// RESET undoes a speech, and half of what that means is on the organizer's tile
// where the whole meeting can see it. Which half is not RESET's to decide: "Show
// my own background" already says what idle looks like for this organizer, and
// pressing a button is not a change of mind about it.
describe('RESET and the "Show my own background" preference', () => {
  it('puts the blue card back when the organizer opted out of reveals', async () => {
    // Off is the default, and nothing of ours is on the tile — the state after
    // the eraser, or before the meeting's first speech.
    isOverlayActive.mockReturnValue(false);
    renderLive();
    // The mount push is not what is under test.
    applyOverlay.mockClear();

    await act(async () => {
      fireEvent.click(resetButton());
    });

    expect(applyOverlay).toHaveBeenCalledWith('/backgrounds/blue.png');
    // Stripping the tile is the one thing this organizer opted out of.
    expect(clearVideoPipelines).not.toHaveBeenCalled();
  });

  it('hands the organizer their own background back when reveals are on', async () => {
    localStorage.setItem(REVEAL_KEY, 'true');
    isOverlayActive.mockReturnValue(true);
    renderLive();
    applyOverlay.mockClear();

    await act(async () => {
      fireEvent.click(resetButton());
    });

    // The clear is what restores their own image; pushing a card here would be
    // the exact thing the preference asks the app not to do.
    expect(clearVideoPipelines).toHaveBeenCalled();
    expect(applyOverlay).not.toHaveBeenCalled();
  });

  it('says which of the two it will do', () => {
    const { unmount } = renderLive();
    expect(resetButton().getAttribute('data-tooltip')).toContain('put the blue timer card back on your video');
    unmount();

    localStorage.setItem(REVEAL_KEY, 'true');
    renderLive();
    expect(resetButton().getAttribute('data-tooltip')).toContain('hand your own background back');
  });
});

describe('the starting role when Standard Speech is removed', () => {
  // A device (or club) that removed Standard Speech and added its own roles.
  const CHAIR = { green: 60, yellow: 90, red: 120, graceAfterRed: 30 };
  beforeEach(() => {
    localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify(['Standard Speech']));
    localStorage.setItem('toastmaster_role_rules', JSON.stringify({ ChairToast1: CHAIR }));
    localStorage.setItem('toastmaster_role_order', JSON.stringify(['ChairToast1']));
  });

  const rolePicker = () => screen.getAllByRole('combobox')[0];

  it('starts on the first role in the list and times it with that role\'s rules', () => {
    renderLive();

    expect(rolePicker()).toHaveValue('Short Roles');
    expect(screen.getByText(/Timing rules: Green: 30 seconds/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(screen.queryByText('Please set timing rules first')).not.toBeInTheDocument();
    expect(applyOverlay).toHaveBeenCalled();
  });

  it('starts on an added role when every built-in is removed, and START works', () => {
    localStorage.setItem('toastmaster_hidden_builtin_roles', JSON.stringify(Object.keys(DEFAULT_ROLE_RULES)));
    renderLive();

    expect(rolePicker()).toHaveValue('ChairToast1');
    expect(screen.getByText(/Timing rules: Green: 1 minute/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(screen.queryByText('Please set timing rules first')).not.toBeInTheDocument();
    expect(applyOverlay).toHaveBeenCalled();
  });
});

// Reach: how many people a START served, not how many times it was pressed.
// Only a count leaves the device, and only when Zoom gave us the whole list.
describe('timer_started and the meeting audience (#107)', () => {
  const NO_PARTICIPANTS = { participants: [], role: 'host', restricted: false };
  const people = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Person ${i}` }));
  const startButton = () => screen.getByRole('button', { name: /start/i });
  const STANDARD = DEFAULT_ROLE_RULES['Standard Speech'];

  afterEach(() => {
    // Back to the module mock's default so other suites see an empty list.
    getZoomParticipants.mockReset();
    getZoomParticipants.mockResolvedValue(NO_PARTICIPANTS);
  });

  /** Let the idle callback and any participant read behind it run to completion. */
  async function flushIdleWork() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  /**
   * Open the app with `atOpen` in the meeting, let the mount-time reads
   * (the speaker suggestions) finish, then forget them: every assertion on
   * getZoomParticipants below is about the read START makes.
   */
  async function openApp(atOpen = NO_PARTICIPANTS) {
    getZoomParticipants.mockResolvedValue(atOpen);
    renderLive();
    await flushIdleWork();
    getZoomParticipants.mockClear();
  }

  const timerStartedCalls = () => trackEvent.mock.calls.filter(([name]) => name === 'timer_started');

  /** The one timer_started event's properties; fails if it was not sent exactly once. */
  function timerStartedProps() {
    const calls = timerStartedCalls();
    expect(calls).toHaveLength(1);
    return calls[0][1];
  }

  it('AC-1: carries audience_size for a host with the full list, alongside the usual properties', async () => {
    const meeting = { participants: people(3), role: 'host', restricted: false };
    await openApp(meeting);
    getZoomParticipants.mockResolvedValue(meeting);
    pickFromAgenda('Alice');

    fireEvent.click(startButton());
    await flushIdleWork();

    expect(timerStartedProps()).toEqual({
      speaker_name: 'Alice',
      role: 'Standard Speech',
      timing_rules: { green: STANDARD.green, yellow: STANDARD.yellow, red: STANDARD.red },
      audience_size: 3,
    });
  });

  it('AC-2: counts the people in the meeting at START, not when the app opened', async () => {
    await openApp({ participants: people(1), role: 'host', restricted: false });
    // Three more people join after the app opened.
    getZoomParticipants.mockResolvedValue({ participants: people(4), role: 'host', restricted: false });

    fireEvent.click(startButton());
    await flushIdleWork();

    expect(getZoomParticipants).toHaveBeenCalled();
    expect(timerStartedProps()).toMatchObject({ audience_size: 4 });
  });

  it('AC-3: leaves audience_size out when the organizer is neither host nor co-host', async () => {
    const meeting = { participants: people(1), role: 'attendee', restricted: true };
    await openApp(meeting);
    getZoomParticipants.mockResolvedValue(meeting);

    fireEvent.click(startButton());
    await flushIdleWork();

    // The read at START was made, so leaving the count out is the result of
    // `restricted`, not of never asking.
    expect(getZoomParticipants).toHaveBeenCalled();
    const props = timerStartedProps();
    expect(props).not.toHaveProperty('audience_size');
    expect(props).toMatchObject({ role: 'Standard Speech' });
  });

  it('AC-4: leaves audience_size out when there is no Zoom SDK (empty participant list)', async () => {
    const noSdk = { participants: [], role: '', restricted: false };
    await openApp(noSdk);
    getZoomParticipants.mockResolvedValue(noSdk);

    fireEvent.click(startButton());
    await flushIdleWork();

    expect(getZoomParticipants).toHaveBeenCalled();
    const props = timerStartedProps();
    expect(props).not.toHaveProperty('audience_size');
    expect(props).toMatchObject({ role: 'Standard Speech' });
  });

  it('AC-5: starts at once and still sends timer_started, without audience_size, when the participant read fails', async () => {
    await openApp({ participants: people(2), role: 'host', restricted: false });
    getZoomParticipants.mockRejectedValue(new Error('SDK init failed'));

    fireEvent.click(startButton());
    // START never waits on Zoom: the timer is running before any idle work.
    expect(screen.getByRole('button', { name: 'FINISH' })).toBeInTheDocument();

    await flushIdleWork();

    expect(getZoomParticipants).toHaveBeenCalled();
    const props = timerStartedProps();
    expect(props).not.toHaveProperty('audience_size');
    expect(props).toMatchObject({ role: 'Standard Speech' });
  });
});
