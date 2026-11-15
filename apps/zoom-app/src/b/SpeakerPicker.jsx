import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, CornerDownLeft, Search, Users } from 'lucide-react';
import useZoomParticipants, { participantsNotOnAgenda } from '../hooks/useZoomParticipants';
import { moveFocusWithArrows, usePopover } from './usePopover';

const OPTION = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none';
const GROUP = 'px-3 pb-1 pt-2 text-[11px] font-bold tracking-wide text-slate-500';

/**
 * "Who's speaking?": the speaker button on design B's timer card, and the
 * list it opens (board B-T03).
 *
 * The same two sources the old name field and the stage picker offer: the
 * agenda, and everyone in the meeting who is not on it. Typing filters both;
 * a name that matches nobody is added to the agenda under the current role,
 * which is what Enter has always done with a typed name. A row that needs a
 * role says so and is left to the Agenda tab (onSelectSpeaker refuses it).
 *
 * @param {{
 *   value: string,
 *   role: string,
 *   agendaItems: Array<Object>,
 *   activeSpeakerId: string|null,
 *   needsRole: (item: Object) => boolean,
 *   onSelectSpeaker: (id: string) => void,
 *   onAddSpeaker: (name: string) => void,
 *   onRenameSpeaker: (id: string, name: string) => void,
 *   palette: {soft: string, fg: string},
 * }} props
 */
export default function SpeakerPicker({
  value,
  role,
  agendaItems,
  activeSpeakerId,
  needsRole,
  onSelectSpeaker,
  onAddSpeaker,
  onRenameSpeaker,
  palette,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const buttonRef = useRef(null);
  const popRef = useRef(null);
  const inputRef = useRef(null);
  const { participants, restricted } = useZoomParticipants();

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  usePopover(open, close, [buttonRef, popRef]);

  const typed = query.trim();
  const needle = typed.toLowerCase();
  const upNext = useMemo(
    () => (agendaItems || []).filter((item) => (!item.completed || item.id === activeSpeakerId) && item.name),
    [agendaItems, activeSpeakerId]
  );
  const activeItem = upNext.find((item) => item.id === activeSpeakerId) || null;
  const agendaMatches = needle ? upNext.filter((item) => item.name.toLowerCase().includes(needle)) : upNext;
  const guests = participantsNotOnAgenda(participants, upNext).filter(
    (person) => !needle || person.name.toLowerCase().includes(needle)
  );
  const exact = upNext.find((item) => item.name.trim().toLowerCase() === needle);
  const canAdd = Boolean(typed) && !exact;
  const canRename = Boolean(typed) && activeItem && typed !== activeItem.name.trim();

  const openList = () => {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const finish = () => {
    close();
    buttonRef.current?.focus();
  };

  const pick = (item) => {
    finish();
    onSelectSpeaker(item.id);
  };

  const add = (name) => {
    finish();
    onAddSpeaker(name);
  };

  const handleInputKey = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      popRef.current?.querySelector('[role="option"]')?.focus();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (exact) pick(exact);
    else if (canAdd) add(typed);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : openList())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={value ? `Speaker: ${value}. Change speaker` : "Who's speaking? Pick a speaker"}
        style={{ background: palette.soft, color: palette.fg }}
        className="flex h-9 w-full items-center justify-between gap-1.5 rounded-[10px] px-2.5 text-sm font-semibold"
      >
        <span className={`truncate ${value ? '' : 'font-medium italic opacity-85'}`}>{value || 'Who’s speaking?'}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popRef}
          onKeyDown={(event) => event.target !== inputRef.current && moveFocusWithArrows(event, popRef.current, '[role="option"]')}
          className="absolute left-0 top-full z-30 mt-1.5 w-[300px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-900 shadow-[0_12px_28px_rgba(15,23,42,0.22)]"
        >
          <label className="flex items-center gap-2 border-b border-slate-100 px-3 py-2.5">
            <Search className="h-4 w-4 flex-shrink-0 text-slate-500" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKey}
              placeholder="Type a name, or pick one"
              aria-label="Type a name, or pick one"
              className="min-w-0 flex-1 border-0 text-sm outline-none"
            />
          </label>

          <div role="listbox" aria-label="Speakers" className="max-h-72 overflow-y-auto">
            {canAdd && (
              <button type="button" role="option" aria-selected={false} className={OPTION} onClick={() => add(typed)}>
                <span className="min-w-0 flex-1 truncate">
                  Add <strong>{typed}</strong>
                </span>
                <span className="flex-shrink-0 text-xs text-blue-600">as {role}</span>
              </button>
            )}
            {canRename && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className={OPTION}
                onClick={() => {
                  finish();
                  onRenameSpeaker(activeItem.id, typed);
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  Rename {activeItem.name} to <strong>{typed}</strong>
                </span>
              </button>
            )}

            {agendaMatches.length > 0 && (
              <div className={`${GROUP} ${canAdd || canRename ? 'border-t border-slate-100' : ''}`} role="presentation">
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
            {guests.map((person) => (
              <button
                key={`guest-${person.id || person.name}`}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => add(person.name)}
                className={OPTION}
              >
                <span className="min-w-0 flex-1 truncate">{person.name}</span>
                <span className="max-w-[55%] flex-shrink-0 truncate text-xs text-blue-600">Add as {role}</span>
              </button>
            ))}

            {!canAdd && agendaMatches.length === 0 && guests.length === 0 && (
              <p className="px-3 py-3 text-sm text-slate-500">No speakers yet. Type a name to add one.</p>
            )}
            {restricted && (
              <p className="flex items-start gap-1.5 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                <Users className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                Ask to be made host or co-host to pick speakers from the participant list.
              </p>
            )}
          </div>

          <p className="flex items-center gap-1.5 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <CornerDownLeft className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            A new name and Enter adds them to the agenda
          </p>
        </div>
      )}
    </div>
  );
}
