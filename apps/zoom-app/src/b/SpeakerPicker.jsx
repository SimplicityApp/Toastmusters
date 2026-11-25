import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Users } from 'lucide-react';
import { SpeakerStatus, SpeakerEntryControls, SpeakerEntryOptions, useAddSpeakerPanel } from '@toastmaster-timer/ui/SpeakerEntry';
import useZoomParticipants, { participantsNotOnAgenda } from '../hooks/useZoomParticipants';
import { moveFocusWithArrows, usePopover } from './usePopover';

const OPTION = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none';
const GROUP = 'px-3 pb-1 pt-2 text-[11px] font-bold tracking-wide text-slate-500';

/**
 * "Who's speaking?": the speaker button on design B's timer card, and the
 * popover it opens (board B-T03).
 *
 * The button carries where the speaker stands ("On the agenda · 2 of 3" or "Not
 * on the agenda", #168). The popover holds the same controls as the old look's
 * panel, from the same shared parts and words: the status, the name field (a
 * loaded speaker's new name waits for Update or Enter; with nobody loaded it
 * labels the timer), the actions, the add panel, then the two lists the old name
 * field and the stage picker offer, the agenda and everyone in the meeting who is
 * not on it, and "Speaker options" at the foot. A row that needs a role says so
 * and is left to the Agenda tab (onSelectSpeaker refuses it).
 *
 * @param {{
 *   value: string,
 *   agendaItems: Array<Object>,
 *   activeSpeakerId: string|null,
 *   needsRole: (item: Object) => boolean,
 *   onSelectSpeaker: (id: string) => void,
 *   onSpeakerChange: (name: string) => void,
 *   entry: import('@toastmaster-timer/ui/SpeakerEntry').SpeakerEntry,
 *   palette: {soft: string, fg: string},
 * }} props
 */
export default function SpeakerPicker({
  value,
  agendaItems,
  activeSpeakerId,
  needsRole,
  onSelectSpeaker,
  onSpeakerChange,
  entry,
  palette,
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const popRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const { participants, restricted } = useZoomParticipants();
  const addPanel = useAddSpeakerPanel();
  const labels = entry.labelsFor(addPanel);
  const onAgenda = labels.status.startsWith('On the agenda');

  const close = () => setOpen(false);
  usePopover(open, close, [buttonRef, popRef]);

  const upNext = useMemo(
    () => (agendaItems || []).filter((item) => (!item.completed || item.id === activeSpeakerId) && item.name),
    [agendaItems, activeSpeakerId]
  );
  const activeItem = upNext.find((item) => item.id === activeSpeakerId) || null;
  // With a speaker loaded the field is their name, staged for Update, and the
  // lists stay whole. With nobody loaded a typed name narrows them, so someone
  // already on the agenda can be picked instead.
  const needle = activeItem ? '' : (value || '').trim().toLowerCase();
  // The button names who is on the clock: a loaded row keeps its name until
  // Update, while a quick timing is labelled as it is typed.
  const shown = activeItem ? activeItem.name : value;
  const agendaMatches = needle ? upNext.filter((item) => item.name.toLowerCase().includes(needle)) : upNext;
  const guests = participantsNotOnAgenda(participants, upNext).filter(
    (person) => !needle || person.name.toLowerCase().includes(needle)
  );

  const openList = () => {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const pick = (item) => {
    close();
    buttonRef.current?.focus();
    onSelectSpeaker(item.id);
  };

  const handleInputKey = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      listRef.current?.querySelector('[role="option"]')?.focus();
      return;
    }
    if (event.key !== 'Enter') return;
    // What the filled button does: Update by default, Add with the setting on
    // "add", and nothing with nobody loaded.
    event.preventDefault();
    entry.onCommit();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : openList())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={shown ? `Speaker: ${shown}. ${labels.status}. Change speaker` : `Who's speaking? ${labels.status}. Pick a speaker`}
        title={labels.status}
        style={{ background: palette.soft, color: palette.fg }}
        className="flex h-9 w-full items-center justify-between gap-1.5 rounded-[10px] px-2.5 text-sm font-semibold"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${onAgenda ? 'bg-current' : 'border border-current opacity-80'}`}
        />
        <span className={`min-w-0 flex-1 truncate text-left ${shown ? '' : 'font-medium italic opacity-85'}`}>{shown || 'Who’s speaking?'}</span>
        {onAgenda && (
          <span aria-hidden="true" className="flex-shrink-0 text-[11px] font-medium opacity-85">
            {labels.status.replace('On the agenda · ', '')}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      </button>

      {/* Arrows move between the list's rows only: the name fields, the role
          select and the option radios keep their own. */}
      {open && (
        <div
          ref={popRef}
          onKeyDown={(event) => listRef.current?.contains(event.target) && moveFocusWithArrows(event, listRef.current, '[role="option"]')}
          className="absolute left-0 top-full z-30 mt-1.5 w-[300px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-900 shadow-[0_12px_28px_rgba(15,23,42,0.22)]"
        >
          <div className="space-y-2 border-b border-slate-100 px-3 py-2.5">
            <SpeakerStatus labels={labels} className="text-slate-600" />
            <input
              ref={inputRef}
              value={value || ''}
              onChange={(event) => onSpeakerChange(event.target.value)}
              onKeyDown={handleInputKey}
              placeholder="Type a name, or pick one"
              aria-label="Type a name, or pick one"
              autoComplete="off"
              enterKeyHint="done"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
            />
            <SpeakerEntryControls entry={entry} labels={labels} panel={addPanel} />
          </div>

          <div ref={listRef} role="listbox" aria-label="Speakers" className="max-h-60 overflow-y-auto">
            {agendaMatches.length > 0 && (
              <div className={GROUP} role="presentation">
                AGENDA
              </div>
            )}
            {agendaMatches.map((item) => {
              const active = item.id === activeSpeakerId;
              const blocked = needsRole(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pick(item)}
                  className={`${OPTION} ${active ? 'bg-blue-50' : ''}`}
                >
                  <span className={`min-w-0 flex-1 truncate ${active ? 'font-semibold' : ''}`}>{item.name}</span>
                  {blocked ? (
                    <span className="flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">Pick a role first</span>
                  ) : (
                    <span className="max-w-[45%] flex-shrink-0 truncate text-xs text-slate-500">{item.role}</span>
                  )}
                  {active && <Check className="h-3.5 w-3.5 flex-shrink-0 text-blue-600" aria-hidden="true" />}
                </button>
              );
            })}

            {guests.length > 0 && (
              <div className={`${GROUP} border-t border-slate-100`} role="presentation">
                IN THIS MEETING
              </div>
            )}
            {/* A guest opens the add panel with their name in it, which says
                where they go and under which role before anything is saved. */}
            {guests.map((person) => (
              <button
                key={`guest-${person.id || person.name}`}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => addPanel.show(entry.clockRole, person.name)}
                className={OPTION}
              >
                <span className="min-w-0 flex-1 truncate">{person.name}</span>
                <span className="max-w-[55%] flex-shrink-0 truncate text-xs text-blue-600">Add to the agenda…</span>
              </button>
            ))}

            {agendaMatches.length === 0 && guests.length === 0 && (
              <p className="px-3 py-3 text-sm text-slate-500">{upNext.length ? 'Nobody on the agenda by that name.' : 'No speakers on the agenda yet.'}</p>
            )}
            {restricted && (
              <p className="flex items-start gap-1.5 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                <Users className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                Ask to be made host or co-host to pick speakers from the participant list.
              </p>
            )}
          </div>

          <SpeakerEntryOptions entry={entry} className="border-t border-slate-100 bg-slate-50 px-3 py-2" />
        </div>
      )}
    </div>
  );
}
