import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { BREAK_ROLE, DEFAULT_ROLE_RULES, deriveBreakRules } from '@toastmaster-timer/shared';
import TimerCard from './TimerCard';
import RolePicker from './RolePicker';
import SpeakerPicker from './SpeakerPicker';
import LookRows from './LookRows';
import { BreakPanel, CustomTimesPanel, UpNext, parseTimeText } from './TimerPanels';

vi.mock('../utils/zoomSdk', () => ({
  getZoomParticipants: vi.fn(async () => ({ participants: [{ id: 'p1', name: 'Maria Chen' }], restricted: false })),
}));

const ROLE_RULES = { ...DEFAULT_ROLE_RULES, [BREAK_ROLE]: deriveBreakRules(600) };
const ROLE_OPTIONS = [...Object.keys(DEFAULT_ROLE_RULES), BREAK_ROLE];
const PALETTE = { soft: 'rgba(255,255,255,0.22)', fg: '#fff' };
const AGENDA = [
  { id: 'a1', name: 'Bob', role: 'Ice Breaker', completed: false },
  { id: 'a2', name: 'Alex', role: 'Table Topics Master', completed: false },
  { id: 'a3', name: 'Alice', role: 'Standard Speech', completed: false },
];
const needsRole = (item) => !ROLE_OPTIONS.includes(item.role);

function renderCard(over = {}) {
  const handlers = {
    onStart: vi.fn(), onStop: vi.fn(), onContinue: vi.fn(), onReset: vi.fn(), onFinish: vi.fn(),
    onPreviewColor: vi.fn(), onEditRules: vi.fn(), onRoleChange: vi.fn(),
    onSelectSpeaker: vi.fn(), onAddSpeaker: vi.fn(), onRenameSpeaker: vi.fn(),
  };
  const props = {
    status: 'blue', previewColor: null, elapsedTime: 0, isRunning: false,
    rules: DEFAULT_ROLE_RULES['Ice Breaker'], speakerName: 'Bob', selectedRole: 'Ice Breaker',
    roleOptions: ROLE_OPTIONS, roleRules: ROLE_RULES, agenda: AGENDA, activeSpeakerId: 'a1', needsRole,
    readoutPosition: { x: 0.18, y: 0.3 }, readoutVisible: true, clubKit: null, badgePlacement: null,
    videoOff: false, isClearingVideo: false, coachHint: null,
    ...handlers, ...over,
  };
  const view = render(<TimerCard {...props} />);
  return { ...handlers, rerender: (next) => view.rerender(<TimerCard {...props} {...next} />) };
}

const button = (name) => screen.getByRole('button', { name });

describe('TimerCard', () => {
  it('ready: speaker, role, rules, preview swatches, Start and Reset', () => {
    const { onStart, onReset, onEditRules } = renderCard();
    expect(button('Speaker: Bob. Change speaker')).toBeInTheDocument();
    expect(button('Timing role: Ice Breaker. Change role')).toBeInTheDocument();
    expect(screen.getByText('Green 4:00 · Yellow 5:00 · Red 6:00')).toBeInTheDocument();
    expect(screen.getByTestId('timer-status')).toHaveTextContent('Ready · green at 4:00');
    expect(screen.getAllByRole('button', { name: /^Preview .* on your video$/ })).toHaveLength(4);
    fireEvent.click(button('Start'));
    fireEvent.click(button('Reset'));
    fireEvent.click(button('Edit rules'));
    expect(onStart).toHaveBeenCalled();
    expect(onReset).toHaveBeenCalled();
    expect(onEditRules).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
  });

  it('says who is speaking when nobody is', () => {
    renderCard({ speakerName: '' });
    expect(button("Who's speaking? Pick a speaker")).toHaveTextContent('Who’s speaking?');
  });

  it('running: the card takes the status colour, Stop and Finish only, no swatches', () => {
    const { onStop, onFinish } = renderCard({ status: 'green', isRunning: true, elapsedTime: 267 });
    expect(screen.getByTestId('timer-card')).toHaveAttribute('data-status', 'green');
    expect(screen.getByTestId('timer-display')).toHaveTextContent('04:27');
    expect(screen.getByTestId('timer-status')).toHaveTextContent('Green · yellow at 5:00');
    expect(screen.queryByRole('button', { name: /^Preview/ })).toBeNull();
    fireEvent.click(button('Stop'));
    fireEvent.click(button('Finish'));
    expect(onStop).toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalled();
  });

  it('paused: Continue, Reset and Finish', () => {
    const { onContinue } = renderCard({ status: 'yellow', elapsedTime: 331 });
    expect(screen.getByTestId('timer-status')).toHaveTextContent('Paused · red at 6:00');
    fireEvent.click(button('Continue'));
    expect(onContinue).toHaveBeenCalled();
    expect(button('Reset')).toBeInTheDocument();
    expect(button('Finish')).toBeInTheDocument();
  });

  it('video off: Start and the swatches wait for the video', () => {
    renderCard({ videoOff: true });
    expect(button('Start')).toBeDisabled();
    expect(button('Preview green on your video')).toBeDisabled();
    expect(screen.getByTestId('timer-status')).toHaveTextContent('Start works once your video is on');
  });

  it('holds a preview swatch and says so', () => {
    const { onPreviewColor, rerender } = renderCard();
    fireEvent.click(button('Preview green on your video'));
    expect(onPreviewColor).toHaveBeenCalledWith('green');
    rerender({ previewColor: 'green', status: 'green' });
    expect(button('Preview green on your video')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('timer-status')).toHaveTextContent('Previewing green on your video');
  });

  it('hides the rules line for Custom and Take a Break, whose times show below the card', () => {
    renderCard({ selectedRole: BREAK_ROLE, rules: deriveBreakRules(300) });
    expect(screen.queryByRole('button', { name: 'Edit rules' })).toBeNull();
    expect(screen.getByTestId('timer-display')).toHaveTextContent('05:00');
  });

  it('keeps the count-up controls hidden until pointed at, and shows the one-time hint', () => {
    const onCoachSeen = vi.fn();
    renderCard({ coachHint: 'Drag me to move. Point at me to resize or hide.', onCoachSeen });
    expect(screen.getByRole('note')).toHaveTextContent('Drag me to move');
    const controls = button('Make the count-up larger').parentElement;
    expect(controls.className).toContain('opacity-0');
    expect(controls.className).toContain('group-hover/chip:opacity-100');
    fireEvent.mouseEnter(button('Drag to place the count-up participants see on your video').parentElement);
    expect(onCoachSeen).toHaveBeenCalled();
  });

  it('draws no count-up chip in the full-screen mode', () => {
    renderCard({ readoutPosition: null });
    expect(screen.queryByRole('button', { name: /count-up/ })).toBeNull();
  });
});

describe('SpeakerPicker', () => {
  function renderPicker(over = {}) {
    const props = {
      value: 'Bob', role: 'Ice Breaker', agendaItems: AGENDA, activeSpeakerId: 'a1', needsRole,
      onSelectSpeaker: vi.fn(), onAddSpeaker: vi.fn(), onRenameSpeaker: vi.fn(), palette: PALETTE, ...over,
    };
    render(<SpeakerPicker {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /speaker/i }));
    return props;
  }

  it('lists the agenda and the meeting, and marks a row that needs a role', async () => {
    renderPicker();
    expect(screen.getByRole('listbox', { name: 'Speakers' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bob/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Alex/ })).toHaveTextContent('Pick a role first');
    expect(await screen.findByRole('option', { name: /Maria Chen/ })).toHaveTextContent('Add as Ice Breaker');
  });

  it('picks an agenda row, and adds a meeting participant to the agenda', async () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole('option', { name: /Alice/ }));
    expect(props.onSelectSpeaker).toHaveBeenCalledWith('a3');

    fireEvent.click(screen.getByRole('button', { name: /speaker/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Maria Chen/ }));
    expect(props.onAddSpeaker).toHaveBeenCalledWith('Maria Chen');
  });

  it('adds a new typed name on Enter, and offers to rename the current speaker', () => {
    const props = renderPicker();
    const input = screen.getByRole('textbox', { name: 'Type a name, or pick one' });
    fireEvent.change(input, { target: { value: 'Priya' } });
    expect(screen.getByRole('option', { name: /Rename Bob to Priya/ })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onAddSpeaker).toHaveBeenCalledWith('Priya');
  });

  it('picks an existing name on Enter rather than adding it twice', () => {
    const props = renderPicker();
    const input = screen.getByRole('textbox', { name: 'Type a name, or pick one' });
    fireEvent.change(input, { target: { value: 'alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onSelectSpeaker).toHaveBeenCalledWith('a3');
    expect(props.onAddSpeaker).not.toHaveBeenCalled();
  });
});

describe('RolePicker', () => {
  it('lists the roles with their thresholds, then Custom and Take a Break, then the rules', () => {
    const onChange = vi.fn();
    const onEditRules = vi.fn();
    render(<RolePicker role="Ice Breaker" roleOptions={ROLE_OPTIONS} roleRules={ROLE_RULES} onChange={onChange} onEditRules={onEditRules} palette={PALETTE} />);
    fireEvent.click(screen.getByRole('button', { name: /Timing role/ }));
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options[0]).toBe('Short Roles0:30 · 0:45 · 1:00');
    expect(options.slice(-2)).toEqual(['Customset your own times', `${BREAK_ROLE}counts down`]);
    expect(screen.getByRole('option', { name: /Ice Breaker/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('option', { name: /Speech Evaluation/ }));
    expect(onChange).toHaveBeenCalledWith('Speech Evaluation');

    fireEvent.click(screen.getByRole('button', { name: /Timing role/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit roles & timing rules' }));
    expect(onEditRules).toHaveBeenCalled();
  });
});

describe('LookRows', () => {
  it('shows each setting with its value, and opens only its own sheet', () => {
    const onOpen = vi.fn();
    render(<LookRows video="Camera + timer" cards="Classic" sounds="Off" soundsLocked between="Timer card" onOpen={onOpen} />);
    expect(screen.getByRole('button', { name: 'On your video: Camera + timer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sounds, Pro' })).toHaveTextContent('PRO');
    fireEvent.click(screen.getByRole('button', { name: 'Cards: Classic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Between speeches: Timer card' }));
    expect(onOpen.mock.calls).toEqual([['cards'], ['between']]);
  });
});

describe('the panels', () => {
  it('reads typed times the way they are written', () => {
    expect(parseTimeText('1:30', 'minsec')).toBe(90);
    expect(parseTimeText('2', 'minsec')).toBe(120);
    expect(parseTimeText('90', 'seconds')).toBe(90);
    expect(parseTimeText('1:75', 'minsec')).toBeNull();
    expect(parseTimeText('', 'minsec')).toBeNull();
  });

  it('custom times commit on blur and warn about a wrong order', () => {
    const onChange = vi.fn();
    render(<CustomTimesPanel rules={{ green: 90, yellow: 60, red: 150, graceAfterRed: 15 }} mode="minsec" onModeChange={() => {}} onChange={onChange} />);
    expect(screen.getByText('Yellow must be greater than Green')).toBeInTheDocument();
    const green = screen.getByLabelText('Green');
    fireEvent.change(green, { target: { value: '0:45' } });
    fireEvent.blur(green);
    expect(onChange).toHaveBeenCalledWith('green', 45);
  });

  it('break length: one tap per quick pick, and a custom length', () => {
    const onChange = vi.fn();
    render(<BreakPanel seconds={600} explanation="Counts down from 10 minutes." mode="minsec" onModeChange={() => {}} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '10 min' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '5 min' }));
    expect(onChange).toHaveBeenCalledWith(300);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByLabelText('Length')).toBeInTheDocument();
  });

  it('up next says when that row still needs a role', () => {
    render(<UpNext item={AGENDA[1]} needsRole />);
    expect(screen.getByTestId('up-next')).toHaveTextContent('Up nextAlexPick a role');
  });
});
