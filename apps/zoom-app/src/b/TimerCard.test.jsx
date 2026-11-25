import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BREAK_ROLE, DEFAULT_ROLE_RULES, actionLabels, deriveBreakRules } from '@toastmaster-timer/shared';
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

/** The speaker bundle useLiveTimer passes: the real words, spies for the actions. */
function speakerEntry({ agenda = AGENDA, loadedRowId = 'a1', name = 'Bob', role = 'Ice Breaker' } = {}) {
  return {
    labelsFor: (add = {}) => actionLabels({ agenda, loadedRowId, name, role, addName: add.name, addRole: add.role }),
    roleOptions: ROLE_OPTIONS,
    clockRole: role,
    insertPosition: 'afterActive',
    enterAction: 'update',
    onCommit: vi.fn(),
    onUpdate: vi.fn(),
    onUndo: vi.fn(),
    onAddSpeaker: vi.fn(),
    onSwitchToQuickTiming: vi.fn(),
    onBackToAgenda: vi.fn(),
    onSaveToAgenda: vi.fn(),
    onInsertPositionChange: vi.fn(),
    onEnterActionChange: vi.fn(),
  };
}

function renderCard(over = {}) {
  const handlers = {
    onStart: vi.fn(), onStop: vi.fn(), onContinue: vi.fn(), onReset: vi.fn(), onFinish: vi.fn(),
    onPreviewColor: vi.fn(), onEditRules: vi.fn(), onRoleChange: vi.fn(),
    onSelectSpeaker: vi.fn(), onSpeakerChange: vi.fn(),
  };
  const props = {
    status: 'blue', previewColor: null, elapsedTime: 0, isRunning: false,
    rules: DEFAULT_ROLE_RULES['Ice Breaker'], speakerName: 'Bob', selectedRole: 'Ice Breaker',
    roleOptions: ROLE_OPTIONS, roleRules: ROLE_RULES, agenda: AGENDA, activeSpeakerId: 'a1', needsRole,
    readoutPosition: { x: 0.18, y: 0.3 }, readoutVisible: true, clubKit: null, badgePlacement: null,
    videoOff: false, isClearingVideo: false, coachHint: null,
    speakerEntry: speakerEntry({ name: over.speakerName ?? 'Bob', loadedRowId: over.speakerName === '' ? null : 'a1' }),
    ...handlers, ...over,
  };
  const view = render(<TimerCard {...props} />);
  return { ...handlers, rerender: (next) => view.rerender(<TimerCard {...props} {...next} />) };
}

const button = (name) => screen.getByRole('button', { name });

describe('TimerCard', () => {
  it('ready: speaker, role, rules, preview swatches, Start and Reset', () => {
    const { onStart, onReset, onEditRules } = renderCard();
    expect(button('Speaker: Bob. On the agenda · 1 of 3. Change speaker')).toBeInTheDocument();
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

  it('marks the speaker button while a role picked on the role chip waits for Update (#168)', () => {
    renderCard({ selectedRole: 'Table Topics Speech', speakerEntry: speakerEntry({ role: 'Table Topics Speech' }) });
    expect(button('Speaker: Bob. On the agenda · 1 of 3. Unsaved changes. Change speaker')).toHaveAttribute(
      'title',
      'On the agenda · 1 of 3. Unsaved changes'
    );
  });

  it('says who is speaking when nobody is', () => {
    renderCard({ speakerName: '', activeSpeakerId: null });
    expect(button("Who's speaking? Not on the agenda. Pick a speaker")).toHaveTextContent('Who’s speaking?');
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

  it('paints the status line without opacity, so the chip and badge buttons stay clickable over it', () => {
    renderCard();
    expect(screen.getByTestId('timer-status').className).not.toMatch(/opacity/);
  });

  it('draws no count-up chip in the full-screen mode', () => {
    renderCard({ readoutPosition: null });
    expect(screen.queryByRole('button', { name: /count-up/ })).toBeNull();
  });
});

describe('SpeakerPicker', () => {
  function renderPicker(over = {}) {
    const { loadedRowId = 'a1', ...rest } = over;
    const props = {
      value: 'Bob', agendaItems: AGENDA, activeSpeakerId: loadedRowId, needsRole,
      onSelectSpeaker: vi.fn(), palette: PALETTE, ...rest,
    };
    const entry = speakerEntry({ loadedRowId });
    // The value controlled the way TimerTab controls it, and the words read for it.
    function Harness() {
      const [value, setValue] = useState(props.value);
      const labelsFor = (add = {}) => actionLabels({
        agenda: AGENDA, loadedRowId, name: value, role: 'Ice Breaker', addName: add.name, addRole: add.role,
      });
      return <SpeakerPicker {...props} value={value} onSpeakerChange={setValue} entry={{ ...entry, labelsFor }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /speaker/i }));
    return { ...props, entry };
  }

  it('lists the agenda and the meeting, and marks a row that needs a role', async () => {
    renderPicker();
    expect(screen.getByRole('listbox', { name: 'Speakers' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bob/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: /Alex/ })).toHaveTextContent('Pick a role first');
    expect(await screen.findByRole('option', { name: /Maria Chen/ })).toHaveTextContent('Add to the agenda…');
  });

  it('picks an agenda row, and opens the add panel for a meeting participant (#168)', async () => {
    const props = renderPicker();
    fireEvent.click(screen.getByRole('option', { name: /Alice/ }));
    expect(props.onSelectSpeaker).toHaveBeenCalledWith('a3');

    fireEvent.click(screen.getByRole('button', { name: /speaker/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Maria Chen/ }));
    expect(screen.getByRole('textbox', { name: 'New speaker’s name' })).toHaveValue('Maria Chen');
    expect(props.entry.onAddSpeaker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Add Maria Chen after Bob/ }));
    expect(props.entry.onAddSpeaker).toHaveBeenCalledWith('Maria Chen', 'Ice Breaker');
  });

  it('holds the loaded speaker; a new name waits for Update, and Enter does what Update does (#168)', () => {
    const props = renderPicker();
    const input = screen.getByRole('textbox', { name: 'Type a name, or pick one' });
    expect(input).toHaveValue('Bob');
    expect(screen.getByText('On the agenda · 1 of 3')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Priya' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // The button still names who is on the clock until Update.
    expect(screen.getByRole('button', { name: /^Speaker: Bob\./ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Update Bob on the agenda/ }));
    expect(props.entry.onUpdate).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.entry.onCommit).toHaveBeenCalled();
    expect(props.entry.onAddSpeaker).not.toHaveBeenCalled();
  });

  it('narrows the lists to a typed name, and keeps "Speaker options" at the foot, collapsed', () => {
    renderPicker({ value: '', loadedRowId: null });
    const input = screen.getByRole('textbox', { name: 'Type a name, or pick one' });
    fireEvent.change(input, { target: { value: 'ali' } });
    expect(screen.getByRole('option', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bob/ })).toBeNull();
    expect(screen.getByText('Speaker options').closest('details').open).toBe(false);
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
