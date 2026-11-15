import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  resetClubForTests,
  resetEntitlementForTests,
  resetFlagsForTests,
  setEntitlement,
  setFlags,
} from '@toastmaster-timer/shared';
import { ToastProvider } from '../context/ToastContext';
import { TimerProvider } from '../context/TimerContext';
import AgendaTabB from './AgendaTabB';
import ReportTabB from './ReportTabB';
import RulesSheet from './RulesSheet';

vi.mock('../utils/posthog', () => ({ trackEvent: vi.fn() }));
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
vi.mock('../utils/zoomIdentity', () => ({
  resolveZoomIdentity: vi.fn(async () => ({ identified: false })),
  getSessionToken: vi.fn(() => null),
}));

const wrap = (ui) =>
  render(
    <ToastProvider>
      <TimerProvider>{ui}</TimerProvider>
    </ToastProvider>
  );

const seedAgenda = (items) => localStorage.setItem('toastmaster_agenda', JSON.stringify(items));
const seedReports = (items) => localStorage.setItem('toastmaster_reports', JSON.stringify(items));

beforeEach(() => {
  localStorage.clear();
  resetFlagsForTests();
  resetEntitlementForTests();
  resetClubForTests();
});

describe('the new-look Agenda tab', () => {
  it('offers the paste and the add when there is no agenda', () => {
    wrap(<AgendaTabB />);
    expect(screen.getByText('No speakers yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paste from EasySpeak' }));
    expect(screen.getByRole('dialog', { name: 'Paste agenda' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'From EasySpeak' })).toHaveAttribute('aria-selected', 'true');
  });

  it('counts a one-per-line paste before adding it, and leaves an unknown role for a pick', () => {
    wrap(<AgendaTabB />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste from EasySpeak' }));
    fireEvent.click(screen.getByRole('tab', { name: 'One per line' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'One speaker per line' }), {
      target: { value: 'Ana (Ice Breaker)\nAlex (Table Topics Master)' },
    });
    expect(screen.getByText(/Found 2 speakers/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 speakers' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    const list = screen.getByRole('list', { name: 'Agenda' });
    expect(within(list).getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText(/1 row needs a role/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Pick a role for Alex' }), { target: { value: 'Table Topics Speech' } });
    expect(screen.queryByText(/row needs a role/)).toBeNull();
  });

  it('adds a speaker from the sheet with the role\'s times shown', () => {
    wrap(<AgendaTabB />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a speaker' }));
    const sheet = screen.getByRole('dialog', { name: 'Add speaker' });
    expect(within(sheet).getByRole('button', { name: 'Add to agenda' })).toBeDisabled();
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Name' }), { target: { value: 'Priya' } });
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Role' }), { target: { value: 'Ice Breaker' } });
    expect(within(sheet).getByText('Green 4:00')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add to agenda' }));
    expect(within(screen.getByRole('list', { name: 'Agenda' })).getByText('Priya')).toBeInTheDocument();
  });

  it('puts a speaker on the timer, but not one that needs a role', () => {
    seedAgenda([
      { id: 'a1', name: 'Bob', role: 'Ice Breaker', completed: false },
      { id: 'a2', name: 'Alex', role: 'Table Topics Master', completed: false },
    ]);
    const onSwitchToLive = vi.fn();
    wrap(<AgendaTabB onSwitchToLive={onSwitchToLive} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alex: pick a role first' }));
    expect(onSwitchToLive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Put Bob on the timer' }));
    expect(onSwitchToLive).toHaveBeenCalled();
  });

  it('asks before clearing the agenda', () => {
    seedAgenda([{ id: 'a1', name: 'Bob', role: 'Ice Breaker', completed: false }]);
    wrap(<AgendaTabB />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the agenda' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear the agenda' }).slice(-1)[0]);
    expect(screen.getByText('No speakers yet')).toBeInTheDocument();
  });
});

describe('the new-look Report tab', () => {
  it('sends an empty report back to the timer', () => {
    const onGoToTimer = vi.fn();
    wrap(<ReportTabB onGoToTimer={onGoToTimer} />);
    expect(screen.getByText('No speeches timed yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the timer' }));
    expect(onGoToTimer).toHaveBeenCalled();
  });

  it('lists each speech with its time, colour or over time, and comment', () => {
    seedReports([
      { speechId: 's1', name: 'Bob', role: 'Ice Breaker', duration: '05:42', color: 'yellow' },
      { speechId: 's2', name: 'Alex', role: 'Table Topics Speech', duration: '02:41', color: 'red', disqualified: true },
      { speechId: 's3', name: 'Sam', role: 'Speech Evaluation', duration: '01:12', color: 'blue', comments: 'Stopped early' },
    ]);
    wrap(<ReportTabB />);
    expect(screen.getByText('3 speeches · 1 over time')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Speeches timed' })).getAllByRole('listitem');
    // Capitalised by CSS; the text itself is the stored colour.
    expect(rows[0]).toHaveTextContent('BobIce Breaker05:42yellow');
    expect(rows[1]).toHaveTextContent('OVER TIME');
    expect(rows[2]).toHaveTextContent('“Stopped early”');
    expect(screen.getByText(/still talking past red/)).toBeInTheDocument();
  });

  it('copies the report as text', async () => {
    seedReports([{ speechId: 's1', name: 'Bob', role: 'Ice Breaker', duration: '05:42', color: 'yellow' }]);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(<ReportTabB />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Bob\tIce Breaker\t05:42\tyellow'));
  });

  it('pitches Pro only once it can be bought, and never to a Pro plan', () => {
    seedReports([{ speechId: 's1', name: 'Bob', role: 'Ice Breaker', duration: '05:42', color: 'yellow' }]);
    setFlags({ pro: false });
    setEntitlement({ plan: 'free' });
    const view = wrap(<ReportTabB />);
    expect(screen.queryByRole('button', { name: 'See Pro' })).toBeNull();
    view.unmount();

    act(() => setFlags({ pro: true }));
    wrap(<ReportTabB />);
    expect(screen.getByRole('button', { name: 'See Pro' })).toBeInTheDocument();
  });
});

describe('the Roles & timing rules sheet', () => {
  it('lists every role with its times, and opens one to edit', () => {
    wrap(<RulesSheet open onClose={() => {}} />);
    const sheet = screen.getByRole('dialog', { name: 'Roles & timing rules' });
    expect(within(sheet).getByRole('button', { name: /Ice Breaker\s*4:00 · 5:00 · 6:00/ })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /Ice Breaker/ }));
    expect(within(sheet).getByLabelText('Green')).toHaveValue('4:00');
    expect(within(sheet).getByRole('button', { name: 'Remove Ice Breaker' })).toBeInTheDocument();
  });

  it('saves an edited time', async () => {
    const onClose = vi.fn();
    wrap(<RulesSheet open onClose={onClose} />);
    const sheet = screen.getByRole('dialog', { name: 'Roles & timing rules' });
    fireEvent.click(within(sheet).getByRole('button', { name: /Ice Breaker/ }));
    const green = within(sheet).getByLabelText('Green');
    fireEvent.change(green, { target: { value: '3:30' } });
    fireEvent.blur(green);
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    });
    expect(onClose).toHaveBeenCalled();
    const stored = JSON.parse(localStorage.getItem('toastmaster_role_rules') || '{}');
    expect(stored['Ice Breaker']?.green).toBe(210);
  });

  it('adds a role that opens for its name', () => {
    wrap(<RulesSheet open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));
    expect(screen.getByRole('textbox', { name: 'Role name' })).toBeInTheDocument();
  });
});
