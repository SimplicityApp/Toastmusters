import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { resetClubForTests, resetEntitlementForTests, resetFlagsForTests, setEntitlement, setFlags } from '@toastmaster-timer/shared';
import { resolveZoomIdentity } from '../utils/zoomIdentity';
import UpgradeModal from '../components/UpgradeModal';
import ClubSurveyModal from '../components/ClubSurveyModal';
import ProLaunchModal from '../components/ProLaunchModal';
import TimerStage from '../components/TimerStage';
import { LookContext } from './LookContext';

vi.mock('../utils/zoomSdk', () => ({
  openExternalUrl: vi.fn(),
  getBackgroundUrl: vi.fn((color) => `/backgrounds/${color}.png`),
  getZoomParticipants: vi.fn(async () => ({ participants: [], restricted: false })),
}));
vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(),
  getSessionToken: vi.fn(() => 'session-token'),
}));
vi.mock('../utils/clubSurvey', () => ({ submitClubResponse: vi.fn(() => true) }));

const inB = (ui) => render(<LookContext.Provider value="b">{ui}</LookContext.Provider>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetClubForTests();
  resetEntitlementForTests();
  resetFlagsForTests();
  resolveZoomIdentity.mockResolvedValue({ identified: true, uid: 'u1' });
  global.fetch = vi.fn();
  setFlags({ pro: true, sounds: true, new_look: true });
  setEntitlement({ plan: 'free' });
});

describe('Pro in design B', () => {
  it('opens Upgrade as a sheet with the PRO tag, the same content inside', async () => {
    const onClose = vi.fn();
    inB(<UpgradeModal isOpen onClose={onClose} source="pro_chip" />);
    const sheet = screen.getByRole('dialog', { name: 'One Pro account for your whole club' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveTextContent('PRO');
    expect(await screen.findByLabelText('Already on Pro through your club?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps today\'s dialog outside design B', () => {
    render(<UpgradeModal isOpen onClose={() => {}} source="footer" />);
    expect(screen.queryByTestId('sheet-backdrop')).toBeNull();
  });

  it('shows the launch announcement under the four cards, then hands off to the Upgrade sheet', () => {
    const onDismiss = vi.fn();
    inB(<ProLaunchModal isOpen onAnswered={() => {}} onDismiss={onDismiss} />);
    const dialog = screen.getByRole('dialog', { name: 'New: Pro for your club' });
    expect(dialog).toHaveTextContent('NEW');
    expect(dialog).toHaveTextContent('The timer itself stays free. Not the one who decides? Tell your club officers.');
    expect(dialog).toHaveTextContent('A chime when the card changes, and music during breaks');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('notices in design B', () => {
  it('asks which club as a sheet', () => {
    const onDismiss = vi.fn();
    inB(<ClubSurveyModal isOpen onAnswered={() => {}} onDismiss={onDismiss} onDecline={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Which club are you from?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't ask me again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('the stage in design B', () => {
  it('names the share for what the meeting will see', () => {
    const props = {
      status: 'green', elapsedTime: 267, rules: { green: 240, yellow: 300, red: 360 }, speakerName: 'Bob', role: 'Ice Breaker',
      isRunning: true, onStart() {}, onContinue() {}, onStop() {}, onReset() {}, onFinish() {}, onExit() {},
      clockHidden: false, onToggleClock() {}, isSharing: false, onToggleShare: vi.fn(), isPoppedOut: false, onTogglePopout() {},
      canPopout: true, onSpeakerNameChange() {}, agendaItems: [], activeSpeakerId: null, onSelectSpeaker() {},
      clubKit: null, badgePlacement: null,
    };
    const view = inB(<TimerStage {...props} />);
    expect(screen.getByRole('button', { name: 'Share the timer to the meeting' })).toHaveTextContent('Share to the meeting');
    view.unmount();
    render(<TimerStage {...props} />);
    expect(screen.getByRole('button', { name: 'Screenshare the timer' })).toHaveTextContent('Screenshare');
  });
});
