import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { actionLabels } from '@toastmaster-timer/shared';
import StageSpeakerPicker from './StageSpeakerPicker';
import { getZoomParticipants } from '../utils/zoomSdk';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ getZoomParticipants: vi.fn() }));

beforeEach(() => {
  getZoomParticipants.mockResolvedValue({ participants: [], role: 'host', restricted: false });
});

function renderPicker(overrides = {}) {
  const { loadedRowId = null, ...rest } = overrides;
  const props = {
    agendaItems: [],
    activeSpeakerId: loadedRowId,
    onSelectSpeaker: vi.fn(),
    ...rest,
  };
  // The speaker bundle useLiveTimer passes: the real words for the field's
  // value, spies for the actions.
  const entry = {
    roleOptions: ['Standard Speech', 'Table Topics'],
    clockRole: 'Table Topics',
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

  function Harness() {
    const [value, setValue] = useState(props.value || '');
    const labelsFor = (add = {}) => actionLabels({
      agenda: props.agendaItems,
      loadedRowId,
      name: value,
      role: 'Table Topics',
      addName: add.name,
      addRole: add.role,
    });
    return <StageSpeakerPicker {...props} value={value} onChange={setValue} entry={{ ...entry, labelsFor }} />;
  }

  render(<Harness />);
  return { ...props, entry };
}

const openMenu = async (user) =>
  user.click(await screen.findByLabelText('Choose a speaker from the agenda or the meeting'));

describe('StageSpeakerPicker', () => {
  it('offers the meeting when there is no agenda to move around in', async () => {
    const user = userEvent.setup();
    // The stage is where typing is hardest — it may be on a shared screen — and a
    // club running Table Topics off no agenda had no list here at all, while Zoom
    // already knew everyone's name.
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'p1', name: 'Priya' }, { id: 'p2', name: 'Sam' }],
      role: 'host',
      restricted: false,
    });
    const { entry } = renderPicker();

    await openMenu(user);

    expect(await screen.findByText('Zoom Participants')).toBeInTheDocument();
    await user.click(screen.getByText('Sam'));

    // Picking opens the add panel with the name in it (#168): it says where
    // they go and under which role before anything is written, and adding puts
    // the meeting on a running order the report can follow.
    expect(screen.getByRole('textbox', { name: 'New speaker’s name' })).toHaveValue('Sam');
    expect(entry.onAddSpeaker).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Add Sam at the end/ }));
    expect(entry.onAddSpeaker).toHaveBeenCalledWith('Sam', 'Table Topics');
  });

  it('labels both groups, and each on its own', async () => {
    const user = userEvent.setup();
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'p2', name: 'Sam' }],
      role: 'host',
      restricted: false,
    });
    renderPicker({
      agendaItems: [
        { id: 'a1', name: 'Priya', role: 'Standard Speech' },
        { id: 'a2', name: 'Dana', role: 'Evaluation' },
      ],
    });

    await openMenu(user);

    expect(await screen.findByText('Agenda')).toBeInTheDocument();
    expect(screen.getByText('Zoom Participants')).toBeInTheDocument();
  });

  it('leaves someone already on the agenda out of the meeting group', async () => {
    const user = userEvent.setup();
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'p1', name: 'priya ' }],
      role: 'host',
      restricted: false,
    });
    renderPicker({
      agendaItems: [
        { id: 'a1', name: 'Priya', role: 'Standard Speech' },
        { id: 'a2', name: 'Dana', role: 'Evaluation' },
      ],
    });

    await openMenu(user);

    // Their agenda entry carries a role and a place in the order; the bare name
    // would be the worse of the two to offer alongside it.
    expect(await screen.findByText('Agenda')).toBeInTheDocument();
    expect(screen.queryByText('Zoom Participants')).not.toBeInTheDocument();
    expect(screen.getAllByText(/priya/i)).toHaveLength(1);
  });

  it('picks an agenda speaker by their place in the order', async () => {
    const user = userEvent.setup();
    const { onSelectSpeaker } = renderPicker({
      agendaItems: [
        { id: 'a1', name: 'Priya', role: 'Standard Speech' },
        { id: 'a2', name: 'Dana', role: 'Evaluation' },
      ],
      activeSpeakerId: 'a1',
    });

    await openMenu(user);
    await user.click(await screen.findByText('Dana'));

    expect(onSelectSpeaker).toHaveBeenCalledWith('a2');
  });

  it('stages a rename until Update, and Enter does what Update does (#168)', async () => {
    const user = userEvent.setup();
    const { entry } = renderPicker({
      agendaItems: [{ id: 'a1', name: 'Priya', role: 'Table Topics' }],
      loadedRowId: 'a1',
      value: 'Priya',
    });

    expect(screen.getByText('On the agenda · 1 of 1')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Speaker name'), 'nka');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Update Priya on the agenda/ }));
    expect(entry.onUpdate).toHaveBeenCalled();

    await user.type(screen.getByLabelText('Speaker name'), '{Enter}');
    expect(entry.onCommit).toHaveBeenCalled();
  });

  it('keeps quick timing at the foot of the list (#168)', async () => {
    const user = userEvent.setup();
    const { entry } = renderPicker({
      agendaItems: [{ id: 'a1', name: 'Priya', role: 'Table Topics' }],
      loadedRowId: 'a1',
      value: 'Priya',
    });

    await openMenu(user);
    await user.click(screen.getByRole('button', { name: /Switch to quick timing/ }));

    expect(entry.onSwitchToQuickTiming).toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('offers no dropdown when there is nowhere to go', async () => {
    renderPicker({ agendaItems: [{ id: 'a1', name: 'Priya', role: 'Standard Speech' }] });

    expect(await screen.findByLabelText('Speaker name')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Choose a speaker from the agenda or the meeting')
    ).not.toBeInTheDocument();
  });
});
