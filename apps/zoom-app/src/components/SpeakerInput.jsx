import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { SpeakerStatus, SpeakerEntryControls, SpeakerEntryOptions, useAddSpeakerPanel } from '@toastmaster-timer/ui/SpeakerEntry';
import useZoomParticipants, { participantsNotOnAgenda } from '../hooks/useZoomParticipants';
import { ChevronDown, Users } from 'lucide-react';

/**
 * @param {'panel'|'stage'} [variant] - 'stage' is the compact form the timer
 *   stage uses: the name field alone, styled for a colored backdrop. The role
 *   picker and the rules link stay behind on the panel, where there is room for
 *   them and where changing a role is not something to do mid-speech in front of
 *   the meeting. The suggestion list is shared, so picking a speaker off the
 *   agenda works the same in both.
 * @param {import('@toastmaster-timer/ui/SpeakerEntry').SpeakerEntry} [entry] -
 *   useLiveTimer's speakerEntry: the status, the actions and the add panel
 *   under the field, and what Enter does (#168). Without it the field only
 *   names the speaker.
 */
export default memo(function SpeakerInput({ value, onChange, onRoleChange, selectedRole, roleOptions, onEditRules, agendaItems, onSelectSuggestion, entry, variant = 'panel' }) {
  const isStage = variant === 'stage';
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const { participants, restricted: participantsRestricted } = useZoomParticipants();
  const inputRef = useRef(null);
  const suggestionsRef = useRef(null);
  const addPanel = useAddSpeakerPanel();
  const labels = entry ? entry.labelsFor(addPanel) : null;

  // Filter agenda items (non-completed, with names)
  const filteredAgendaItems = useMemo(() => (agendaItems || []).filter(item =>
    !item.completed && item.name &&
    item.name.toLowerCase().includes((value || '').toLowerCase())
  ), [agendaItems, value]);

  // Filter participants based on current value, minus anyone the agenda is
  // already offering: picking them there keeps their role and their place in the
  // running order, which the bare name from Zoom cannot.
  const filteredParticipants = useMemo(() => {
    const offAgenda = participantsNotOnAgenda(participants, filteredAgendaItems);
    return (value || '') === ''
      ? offAgenda
      : offAgenda.filter((person) => person.name.toLowerCase().includes(value.toLowerCase()));
  }, [participants, filteredAgendaItems, value]);

  const suggestions = useMemo(() => [
    ...filteredAgendaItems.map(item => ({ ...item, _fromAgenda: true })),
    ...filteredParticipants.map(person => ({ ...person, _fromAgenda: false })),
  ], [filteredAgendaItems, filteredParticipants]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target) &&
          inputRef.current && !inputRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setHighlightIndex(-1);
  }, [value]);

  // An agenda row loads that speaker. Someone in the meeting who is not on the
  // agenda opens the add panel with their name in it (#168): adding them is a
  // choice of where and under which role, which the panel spells out, and
  // copying the bare name into the field would leave whoever is loaded renamed.
  const handleSelect = (item) => {
    if (item._fromAgenda && onSelectSuggestion) {
      onSelectSuggestion(item);
    } else if (entry) {
      addPanel.show(entry.clockRole, item.name);
    } else {
      onChange(item.name);
    }
    setShowSuggestions(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      // A highlighted suggestion is an explicit choice and outranks the typed
      // text, which is only a partial match for it.
      if (showSuggestions && highlightIndex >= 0 && suggestions.length > 0) {
        e.preventDefault();
        handleSelect(suggestions[highlightIndex]);
      } else if (entry) {
        // What the filled button does: Update by default, Add with the setting
        // on "add", nothing with no speaker loaded (the field labels the timer).
        e.preventDefault();
        entry.onCommit();
        setShowSuggestions(false);
      }
      return;
    }
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(prev => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  // Only without the controls under the field, which say what a new name does.
  const isCustomName = !labels && value && value.trim() && !suggestions.some(item =>
    item.name.toLowerCase() === value.trim().toLowerCase()
  );

  // Each group carries its own label whenever it has anything in it, not only
  // when both do. Where a name came from decides what picking it does — an
  // agenda entry brings a role and a place in the running order, a participant
  // is a name off the meeting — so an unlabelled list of names left the
  // organizer guessing at that in the far more common single-group case.
  const hasAgenda = filteredAgendaItems.length > 0;
  const hasParticipants = filteredParticipants.length > 0;

  return (
    <div className={isStage ? '' : 'space-y-3'}>
      {!isStage && (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Timing Role
        </label>
        <div className="relative">
          <select
            value={selectedRole}
            onChange={(e) => onRoleChange(e.target.value)}
            className="w-full pl-3 pr-10 py-2 text-base border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none bg-white"
          >
            {roleOptions.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400 pointer-events-none" />
        </div>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (onEditRules) onEditRules();
          }}
          className="text-xs text-blue-600 hover:text-blue-800 mt-1 inline-block"
        >
          Edit timing rules
        </a>
      </div>
      )}

      <div className="relative">
        {!isStage && (
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Speaker Name
          </label>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value || ''}
          onChange={(e) => {
            onChange(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={isStage ? 'Speaker name' : 'Type speaker name...'}
          aria-label={isStage ? 'Speaker name' : undefined}
          className={
            isStage
              ? 'w-full rounded-md border border-white/30 bg-black/25 py-1.5 px-2.5 text-lg font-semibold text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-white/60 focus:border-transparent'
              : 'w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-3 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
          }
        />
        {showSuggestions && (suggestions.length > 0 || isCustomName || participantsRestricted) && (
          <ul
            ref={suggestionsRef}
            className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto"
          >
            {hasAgenda && (
              <>
                <li className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-50">
                  Agenda
                </li>
                {filteredAgendaItems.map((item, i) => {
                  const index = i;
                  return (
                    <li
                      key={`agenda-${item.id}`}
                      onMouseDown={() => handleSelect({ ...item, _fromAgenda: true })}
                      onMouseEnter={() => setHighlightIndex(index)}
                      className={`px-3 py-2 cursor-pointer text-sm ${
                        index === highlightIndex ? 'bg-blue-50 text-blue-900' : 'text-gray-900 hover:bg-gray-50'
                      }`}
                    >
                      <span className="font-medium">{item.name}</span>
                      <span className="text-gray-500 ml-2 text-xs">{item.role}</span>
                    </li>
                  );
                })}
              </>
            )}
            {hasParticipants && (
              <>
                <li className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-50">
                  Zoom Participants
                </li>
                {filteredParticipants.map((person, i) => {
                  const index = filteredAgendaItems.length + i;
                  return (
                    <li
                      key={person.id}
                      onMouseDown={() => handleSelect({ ...person, _fromAgenda: false })}
                      onMouseEnter={() => setHighlightIndex(index)}
                      className={`px-3 py-2 cursor-pointer text-sm ${
                        index === highlightIndex ? 'bg-blue-50 text-blue-900' : 'text-gray-900 hover:bg-gray-50'
                      }`}
                    >
                      <span className="font-medium">{person.name}</span>
                    </li>
                  );
                })}
              </>
            )}
            {isCustomName && (
              <li className="px-3 py-2 text-sm text-gray-500 border-t border-gray-100">
                New Speaker: "{value.trim()}"
              </li>
            )}
            {/* Only when the list was withheld for a reason the organizer can
                act on, and only at the foot of a list they already opened —
                nothing pops up, nothing blocks typing, and a host never sees it
                at all. Names are still typed by hand meanwhile. */}
            {participantsRestricted && (
              <li className="flex items-start gap-1.5 px-3 py-2 text-xs text-gray-500 border-t border-gray-100 bg-gray-50">
                <Users className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>Ask to be made host or co-host to pick speakers from the participant list.</span>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Under the field, what it would do and where the speaker stands: the
          status, the actions that say what a tap does, and the add panel. */}
      {labels && !isStage && (
        <div className="space-y-2">
          <SpeakerStatus labels={labels} className="text-gray-600" />
          <SpeakerEntryControls entry={entry} labels={labels} panel={addPanel} />
          <SpeakerEntryOptions entry={entry} />
        </div>
      )}
    </div>
  );
});
