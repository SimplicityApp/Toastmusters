import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import LiveTab from './LiveTab';
import { BREAK_ROLE, DEFAULT_ROLE_RULES, deriveBreakRules } from '@toastmaster-timer/shared';
import { applyOverlay, clearVideoPipelines, isOverlayActive } from '../utils/zoomSdk';

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
