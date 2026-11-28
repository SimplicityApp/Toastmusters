import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { actionLabels } from '@toastmaster-timer/shared';
import SpeakerInput from './SpeakerInput';
import { getZoomParticipants } from '../utils/zoomSdk';

// Stubbed rather than imported: the real module pulls in @zoom/appssdk, which
// hangs vitest under jsdom.
vi.mock('../utils/zoomSdk', () => ({ getZoomParticipants: vi.fn() }));

// Default to the shape a host sees. Kept faithful to the real return value: a
// stub that answers with a bare array would let the component read `.participants`
// off it as undefined and still pass.
beforeEach(() => {
  getZoomParticipants.mockResolvedValue({ participants: [], role: 'host', restricted: false });
});

const ROLES = ['Standard Speech', 'Table Topics'];

/**
 * Renders with the value controlled the way LiveTab controls it, so typing
 * behaves as it does in the app rather than against a frozen prop. The speaker
 * controls under the field read the real actionLabels for that value; their
 * actions are spies.
 */
function renderInput(overrides = {}) {
  const { loadedRowId = null, ...rest } = overrides;
  const props = {
    onSelectSuggestion: vi.fn(),
    onRoleChange: vi.fn(),
    onEditRules: vi.fn(),
    agendaItems: [],
    selectedRole: 'Standard Speech',
    roleOptions: ROLES,
    ...rest,
  };
  const entry = {
    roleOptions: ROLES,
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
      role: props.selectedRole,
      addName: add.name,
      addRole: add.role,
    });
    return <SpeakerInput {...props} value={value} onChange={setValue} entry={{ ...entry, labelsFor }} />;
  }

  render(<Harness />);
  return { ...props, entry };
}

const field = () => screen.getByPlaceholderText('Type speaker name...');

describe('SpeakerInput', () => {
  it('Enter does what the filled button does (#168)', async () => {
    const user = userEvent.setup();
    const { entry } = renderInput();

    await user.type(field(), 'Priya');
    await user.keyboard('{Enter}');

    expect(entry.onCommit).toHaveBeenCalledTimes(1);
    expect(entry.onAddSpeaker).not.toHaveBeenCalled();
  });

  it('with nobody loaded, a typed name can be saved to the agenda, and the status says so', async () => {
    const user = userEvent.setup();
    const { entry } = renderInput();

    expect(screen.getByText('Not on the agenda')).toBeInTheDocument();
    await user.type(field(), 'Priya');
    await user.click(screen.getByRole('button', { name: /Save Priya to the agenda/ }));

    expect(entry.onSaveToAgenda).toHaveBeenCalled();
  });

  it('with a speaker loaded, a new name waits for "Update Jon on the agenda"', async () => {
    const user = userEvent.setup();
    const { entry } = renderInput({
      agendaItems: [{ id: 'a1', name: 'Jon', role: 'Standard Speech' }],
      loadedRowId: 'a1',
      value: 'Jon',
    });

    expect(screen.getByText('On the agenda · 1 of 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Update Jon on the agenda/ })).not.toBeInTheDocument();
    await user.type(field(), 'athan');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Update Jon on the agenda/ }));

    expect(entry.onUpdate).toHaveBeenCalled();
  });

  it('lets a highlighted suggestion win over the typed text', async () => {
    const user = userEvent.setup();
    // Arrowing to a name is an explicit choice; the typed text is only a partial
    // match for it, so Enter must pick rather than commit.
    const { entry, onSelectSuggestion } = renderInput({
      agendaItems: [{ id: 'a1', name: 'Priya', role: 'Standard Speech', completed: false }],
    });

    await user.type(field(), 'Pri');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSelectSuggestion).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    expect(entry.onCommit).not.toHaveBeenCalled();
  });

  it('opens the add panel on the role on the clock, and adds from it', async () => {
    const user = userEvent.setup();
    const { entry } = renderInput();

    await user.click(screen.getByRole('button', { name: /Add a speaker at the end/ }));
    expect(screen.getByRole('combobox', { name: 'Role for the new speaker' })).toHaveValue('Table Topics');
    await user.type(screen.getByRole('textbox', { name: 'New speaker’s name' }), 'Priya{Enter}');

    expect(entry.onAddSpeaker).toHaveBeenCalledWith('Priya', 'Table Topics');
  });

  it('keeps "Speaker options" collapsed until opened', async () => {
    const user = userEvent.setup();
    const { entry } = renderInput();

    expect(screen.getByText('Speaker options').closest('details').open).toBe(false);
    await user.click(screen.getByText('Speaker options'));
    await user.click(screen.getByRole('radio', { name: 'At the end of the agenda' }));

    expect(entry.onInsertPositionChange).toHaveBeenCalledWith('end');
  });
});

describe('SpeakerInput participant list', () => {
  it('offers everyone in the meeting, the organizer included', async () => {
    const user = userEvent.setup();
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'me', name: 'Priya' }, { id: 'p2', name: 'Sam' }],
      role: 'host',
      restricted: false,
    });
    renderInput();

    await user.click(field());

    expect(await screen.findByText('Priya')).toBeInTheDocument();
    expect(screen.getByText('Sam')).toBeInTheDocument();
    // A host has nothing to act on, so the note stays out of their way.
    expect(screen.queryByText(/host or co-host/i)).not.toBeInTheDocument();
  });

  it('labels the group even when it is the only one', async () => {
    const user = userEvent.setup();
    // Where a name came from decides what picking it does, so a single unlabelled
    // list of names left the organizer guessing at that — and the common case is
    // exactly one group: a club with no agenda imported, or one running from an
    // agenda before anyone has joined.
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'p2', name: 'Sam' }],
      role: 'host',
      restricted: false,
    });
    renderInput();

    await user.click(field());

    expect(await screen.findByText('Zoom Participants')).toBeInTheDocument();
    expect(screen.queryByText('Agenda')).not.toBeInTheDocument();
  });

  it('labels an agenda-only list too', async () => {
    const user = userEvent.setup();
    renderInput({ agendaItems: [{ id: 'a1', name: 'Priya', role: 'Standard Speech' }] });

    await user.click(field());

    expect(await screen.findByText('Agenda')).toBeInTheDocument();
    expect(screen.queryByText('Zoom Participants')).not.toBeInTheDocument();
  });

  it('offers someone on both lists as their agenda entry', async () => {
    const user = userEvent.setup();
    // The agenda entry carries a role and a place in the running order; the
    // participant is a bare name. Offering the name instead used to drop the
    // link to the agenda, so finishing could not advance and the item was never
    // ticked off.
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'p1', name: 'priya' }, { id: 'p2', name: 'Sam' }],
      role: 'host',
      restricted: false,
    });
    const { onSelectSuggestion } = renderInput({
      agendaItems: [{ id: 'a1', name: 'Priya', role: 'Table Topics' }],
    });

    await user.click(field());

    expect(await screen.findByText('Agenda')).toBeInTheDocument();
    // Once, under Agenda — not a second time as a name off the meeting.
    expect(screen.getAllByText(/priya/i)).toHaveLength(1);

    await user.click(screen.getByText('Priya'));
    expect(onSelectSuggestion).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('tells a non-host why the list is short', async () => {
    const user = userEvent.setup();
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'me', name: 'Priya' }],
      role: 'attendee',
      restricted: true,
    });
    renderInput();

    await user.click(field());

    // Their own name still comes through, so the list is never simply empty.
    expect(await screen.findByText('Priya')).toBeInTheDocument();
    expect(screen.getByText(/Ask to be made host or co-host/i)).toBeInTheDocument();
  });

  it('leaves a non-host free to type names as usual', async () => {
    // Non-intrusive has to mean non-blocking: the note sits at the foot of the
    // list and changes nothing about entering a name by hand.
    const user = userEvent.setup();
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'me', name: 'Priya' }],
      role: 'attendee',
      restricted: true,
    });
    const { entry } = renderInput();

    await user.type(field(), 'Dana');
    await user.keyboard('{Enter}');

    expect(field()).toHaveValue('Dana');
    expect(entry.onCommit).toHaveBeenCalled();
  });

  it('opens the add panel with a guest\'s name rather than renaming whoever is loaded (#168)', async () => {
    const user = userEvent.setup();
    getZoomParticipants.mockResolvedValue({
      participants: [{ id: 'p2', name: 'Sam' }],
      role: 'host',
      restricted: false,
    });
    const { entry } = renderInput();

    await user.click(field());
    await user.click(await screen.findByText('Sam'));

    expect(field()).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'New speaker’s name' })).toHaveValue('Sam');
    await user.click(screen.getByRole('button', { name: /Add Sam at the end/ }));
    expect(entry.onAddSpeaker).toHaveBeenCalledWith('Sam', 'Table Topics');
  });
});
