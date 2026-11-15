import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { resetFlagsForTests, setFlags } from '@toastmaster-timer/shared';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import { clearVideoPipelines, setOverlayMode } from '../utils/zoomSdk';
import NewLookShell from './NewLookShell';
import { COACH_SEEN_KEY } from './TimerTab';

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
  isVideoOverlayMode: vi.fn((mode) => mode !== 'stage'),
  getClubBadgePlacement: vi.fn(() => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true })),
  setClubBadgePlacement: vi.fn((patch) => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true, ...patch })),
  resetClubBadgePlacement: vi.fn(() => ({ x: 0.8, y: 0.12, scale: 0.12, visible: true })),
  isClubBadgeMoved: vi.fn(() => false),
  getZoomParticipants: vi.fn().mockResolvedValue({ participants: [], role: 'host', restricted: false }),
  getCardFileUrl: vi.fn((file) => `/cards/${file}`),
  notifyCardImagesChanged: vi.fn(),
  preloadBackgroundImages: vi.fn(),
  notifyOwnBackgroundChanged: vi.fn(),
  applyOwnBackground: vi.fn(),
  removeOwnBackground: vi.fn(),
  openExternalUrl: vi.fn(async () => true),
  OVERLAY_MODE_CARD: 'card',
  OVERLAY_MODE_CAMERA: 'camera',
  OVERLAY_MODE_STAGE: 'stage',
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
// Covered by their own tests; here they would only need more of the SDK stub.
vi.mock('../components/ZoomConnectionNotice', () => ({ default: () => null }));
vi.mock('../components/ContactCapture', () => ({ default: () => null }));
vi.mock('../components/PeriodicPrompts', () => ({ default: () => null }));
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(async () => ({ identified: false })),
  getSessionToken: vi.fn(() => null),
}));

async function renderShell() {
  render(
    <ToastProvider>
      <TimerProvider>
        <NewLookShell />
      </TimerProvider>
    </ToastProvider>
  );
  // The Timer tab is lazy; let it land.
  await screen.findByTestId('timer-card');
}

const openRow = (name) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));

beforeEach(() => {
  localStorage.clear();
  resetFlagsForTests();
  setFlags({ new_look: true, pro: false, sounds: true });
  vi.clearAllMocks();
});

describe('the new-look panel', () => {
  it('opens on the Timer tab, with the top bar and no footer', async () => {
    await renderShell();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(screen.queryByRole('button', { name: /send us feedback/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('opens one sheet per Look & sound row, never two', async () => {
    await renderShell();
    for (const [row, title] of [
      ['On your video', 'On your video'],
      ['Cards', 'Cards'],
      ['Sounds', 'Sounds'],
      ['Between speeches', 'Between speeches'],
    ]) {
      openRow(row);
      const dialogs = await screen.findAllByRole('dialog');
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]).toHaveAccessibleName(title);
      fireEvent.click(within(dialogs[0]).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  });

  it('keeps the own-background picker out of the Cards sheet', async () => {
    await renderShell();
    openRow('Cards');
    const sheet = await screen.findByRole('dialog', { name: 'Cards' });
    expect(within(sheet).queryByText('My background')).toBeNull();
  });

  it('switches the display mode from its sheet, and confirms Timer only', async () => {
    await renderShell();
    openRow('On your video');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Timer only/ }));
    });
    expect(setOverlayMode).toHaveBeenCalledWith('card', expect.anything());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText(/Timer only: the colour replaces your camera/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'On your video: Timer only' })).toBeInTheDocument();
  });

  it('chooses what shows between speeches, and keeps today\'s default', async () => {
    await renderShell();
    expect(screen.getByRole('button', { name: 'Between speeches: Timer card' })).toBeInTheDocument();
    openRow('Between speeches');
    fireEvent.click(screen.getByRole('radio', { name: /My video/ }));
    expect(localStorage.getItem('toastmaster_reveal_face_when_idle')).toBe('true');
    expect(screen.getByText('My background')).toBeInTheDocument();
  });

  it('clears the timer from the video from the ⋯ menu, from another tab too', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(screen.queryByTestId('timer-card')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Clear the timer from my video' }));
    });
    expect(await screen.findByTestId('timer-card')).toBeInTheDocument();
    expect(clearVideoPipelines).toHaveBeenCalledTimes(1);
  });

  it('shows the count-up hint once, until the chip is used', async () => {
    await renderShell();
    expect(screen.getByRole('note')).toHaveTextContent('Drag me to move');
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Drag to place the count-up/ }).parentElement);
    expect(screen.queryByRole('note')).toBeNull();
    expect(localStorage.getItem(COACH_SEEN_KEY)).toBe('1');
  });

  it('says what happened after Finish when the next row needs a role', async () => {
    localStorage.setItem(
      'toastmaster_agenda',
      JSON.stringify([
        { id: 'a1', name: 'Bob', role: 'Ice Breaker', completed: false },
        { id: 'a2', name: 'Alex', role: 'Table Topics Master', completed: false },
      ])
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderShell();
      fireEvent.click(screen.getByRole('button', { name: /speaker/i }));
      fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
      expect(screen.getByTestId('up-next')).toHaveTextContent('Alex');
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
      expect(screen.getByText(/Bob's speech is saved to the report\. Next on the agenda:/)).toHaveTextContent(
        "Bob's speech is saved to the report. Next on the agenda: Alex, who needs a role."
      );
      fireEvent.click(screen.getByRole('button', { name: 'Pick role' }));
      await waitFor(() => expect(screen.queryByTestId('timer-card')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});
