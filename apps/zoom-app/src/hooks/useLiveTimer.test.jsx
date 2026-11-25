import { render, renderHook, act } from '@testing-library/react';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider, useTimer } from '../context/TimerContext';
import { useLiveTimer } from './useLiveTimer';
import { applyOverlay, clearVideoPipelines, isOverlayActive } from '../utils/zoomSdk';

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
