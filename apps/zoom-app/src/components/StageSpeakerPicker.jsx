import { useState, useRef, useEffect, memo } from 'react';
import { ChevronDown, Check, Users, Plus, Undo2 } from 'lucide-react';
import { AddSpeakerPanel, SPEAKER_ICONS, TextAction, useAddSpeakerPanel } from '@toastmaster-timer/ui/SpeakerEntry';
import useZoomParticipants, { participantsNotOnAgenda } from '../hooks/useZoomParticipants';

const STAGE_BUTTON =
  'w-full rounded-md border px-2.5 py-1.5 text-left text-sm font-medium text-white transition-colors';

/**
 * The speaker control on the timer stage.
 *
 * Its own component rather than a variant of SpeakerInput, because what the
 * stage needs and what the panel needs have stopped being the same thing. Here
 * the organizer is mid-meeting, looking at a screen that may be shared, and
 * wants three things within reach: jump to whoever is actually speaking next,
 * add someone who was never on the agenda, and fix a name that came in wrong.
 *
 * The two lists it picks from are the panel's, though: the agenda and everyone
 * in the meeting. A club that runs Table Topics off no agenda at all was
 * otherwise left typing names by hand on the one screen where typing is hardest,
 * while Zoom already knew every one of them.
 *
 * The rules are the panel's too (#168), drawn compact from the same labels: the
 * status, the field (a rename waits for Update or Enter), "+ Add" with its own
 * panel, and quick timing, Back to agenda and Save at the foot of the list.
 *
 * Deliberately not full width: it sits over the timer color, so it takes the
 * space it needs and leaves the rest of the stage to the signal.
 *
 * @param {import('@toastmaster-timer/ui/SpeakerEntry').SpeakerEntry} [entry] -
 *   useLiveTimer's speakerEntry
 */
export default memo(function StageSpeakerPicker({
  value,
  onChange,
  agendaItems,
  activeSpeakerId,
  onSelectSpeaker,
  entry,
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);
  const { participants, restricted: participantsRestricted } = useZoomParticipants();
  const addPanel = useAddSpeakerPanel();
  const labels = entry ? entry.labelsFor(addPanel) : null;

  const upNext = (agendaItems || []).filter((item) => !item.completed || item.id === activeSpeakerId);

  // The other half of the list, and the reason this is a dropdown at all when
  // nothing was imported: a club that never pastes an agenda in still has
  // everyone's name sitting in the meeting. Same two groups the panel field
  // offers, so the two places a speaker gets named agree on who is available.
  const guests = participantsNotOnAgenda(participants, upNext);

  // The actions that live at the foot of the list rather than on the stage.
  const listActions = labels ? [
    labels.quickTiming && !labels.update && {
      icon: SPEAKER_ICONS.quick, label: labels.quickTiming, note: labels.quickTimingNote, run: entry.onSwitchToQuickTiming,
    },
    labels.backToAgenda && {
      icon: SPEAKER_ICONS.back, label: labels.backToAgenda, note: labels.backToAgendaNote, run: entry.onBackToAgenda,
    },
    labels.save && {
      icon: SPEAKER_ICONS.add, label: labels.save, note: labels.saveNote, run: entry.onSaveToAgenda,
    },
  ].filter(Boolean) : [];

  // Worth a dropdown as soon as there is anywhere to go: another agenda entry,
  // anyone in the meeting who is not on it yet, or an action at its foot.
  const hasChoices = upNext.length > 1 || guests.length > 0 || listActions.length > 0;

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Enter does what the filled button does: Update by default, Add with the
  // setting on "add", and nothing with no speaker loaded.
  const handleKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    entry?.onCommit();
    inputRef.current?.blur();
  };

  const pick = (item) => {
    setOpen(false);
    onSelectSpeaker(item.id);
  };

  /**
   * Picking someone who is in the meeting but not on the agenda opens the add
   * panel with their name in it, which says where they go and under which role
   * before anything is written.
   */
  const pickGuest = (person) => {
    setOpen(false);
    if (entry) addPanel.show(entry.clockRole, person.name);
  };

  const openAddPanel = () => {
    setOpen(false);
    addPanel.show(entry.clockRole);
  };

  const onAgenda = labels?.status.startsWith('On the agenda');

  return (
    <div className="relative w-56 max-w-full">
      {labels && (
        <p className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-white/90">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${onAgenda ? 'bg-white' : 'border border-white/80'}`} />
            {labels.status}
          </span>
          {labels.unsaved && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
              {labels.unsaved}
            </span>
          )}
        </p>
      )}
      <div className="flex items-stretch rounded-md border border-white/30 bg-black/25 focus-within:ring-2 focus-within:ring-white/60">
        <input
          ref={inputRef}
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Speaker name"
          aria-label="Speaker name"
          className="min-w-0 flex-1 bg-transparent py-1.5 px-2.5 text-lg font-semibold text-white placeholder-white/50 focus:outline-none"
        />
        {hasChoices && (
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((wasOpen) => !wasOpen)}
            className="px-1.5 text-white/70 hover:text-white transition-colors flex-shrink-0"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Choose a speaker from the agenda or the meeting"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {labels && (
        <div className="mt-1.5 flex flex-col items-start gap-1">
          {labels.update && (
            <>
              {labels.enterAdd && (
                <button type="button" onClick={entry.onCommit} className={`${STAGE_BUTTON} border-white/40 bg-white/15 hover:bg-white/25`}>
                  {labels.enterAdd}
                </button>
              )}
              <button
                type="button"
                onClick={entry.onUpdate}
                className={`${STAGE_BUTTON} ${labels.enterAdd ? 'border-white/20 bg-transparent hover:bg-white/15' : 'border-white/40 bg-white/15 hover:bg-white/25'}`}
              >
                <span className="block">{labels.update}</span>
                <span className="block text-xs font-normal text-white/80">{labels.changes}</span>
              </button>
              <button
                type="button"
                onClick={entry.onUndo}
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-white/85 hover:bg-white/15 hover:text-white"
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                {labels.undo}
              </button>
            </>
          )}
          {!addPanel.open && (
            <button
              type="button"
              onClick={openAddPanel}
              aria-label={labels.addOpener}
              title={labels.addOpener}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-white/85 hover:bg-white/15 hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add
            </button>
          )}
        </div>
      )}

      {addPanel.open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-lg bg-white shadow-lg">
          <AddSpeakerPanel labels={labels} panel={addPanel} roleOptions={entry.roleOptions} onAdd={entry.onAddSpeaker} />
        </div>
      )}

      {open && (
        <div
          ref={menuRef}
          className="absolute left-0 top-full z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
        >
          <ul role="listbox" className="max-h-56 overflow-y-auto">
            {/* Labelled whenever the group has anyone in it, even when it is the
                only group: picking from the agenda moves the timer along a running
                order, picking from the meeting puts someone on it. Same two labels
                as the panel field, so neither list has to be learned twice. */}
            {upNext.length > 0 && (
              <li className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-50" role="presentation">
                Agenda
              </li>
            )}
            {upNext.map((item) => {
              const isActive = item.id === activeSpeakerId;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => pick(item)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate font-medium ${isActive ? 'text-blue-700' : 'text-gray-900'}`}>
                        {item.name || 'Unnamed'}
                      </span>
                      <span className="block truncate text-xs text-gray-500">{item.role}</span>
                    </span>
                    {isActive && <Check className="h-4 w-4 text-blue-600 flex-shrink-0" />}
                  </button>
                </li>
              );
            })}

            {guests.length > 0 && (
              <li className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-50" role="presentation">
                Zoom Participants
              </li>
            )}
            {guests.map((person) => (
              <li key={`guest-${person.id || person.name}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => pickGuest(person)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-gray-900">{person.name}</span>
                    {/* Picking opens the add panel, which spells out where they
                        go and under which role before anything is saved. */}
                    <span className="block truncate text-xs text-gray-500">Add to the agenda…</span>
                  </span>
                </button>
              </li>
            ))}

            {/* Only where the organizer can act on it, and only at the foot of a
                list they opened themselves. A host never sees it. */}
            {participantsRestricted && (
              <li className="flex items-start gap-1.5 px-3 py-2 text-xs text-gray-500 border-t border-gray-100 bg-gray-50">
                <Users className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>Ask to be made host or co-host to pick speakers from the participant list.</span>
              </li>
            )}
          </ul>
          {listActions.length > 0 && (
            <div className="border-t border-gray-100 px-3 py-1">
              {listActions.map((action) => (
                <TextAction
                  key={action.label}
                  icon={action.icon}
                  label={action.label}
                  note={action.note}
                  onClick={() => {
                    setOpen(false);
                    action.run();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
