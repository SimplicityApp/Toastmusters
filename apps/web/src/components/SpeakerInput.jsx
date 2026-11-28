import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { SpeakerStatus, SpeakerEntryControls, SpeakerEntryOptions, useAddSpeakerPanel } from '@toastmaster-timer/ui/SpeakerEntry';
import { ChevronDown } from 'lucide-react';

/**
 * @param {import('@toastmaster-timer/ui/SpeakerEntry').SpeakerEntry} [entry] -
 *   LiveTab's speaker bundle: the status, the actions and the add panel under
 *   the field, and what Enter does (#168), the same parts the Zoom app shows.
 */
export default memo(function SpeakerInput({ value, onChange, onRoleChange, selectedRole, roleOptions, onEditRules, agendaItems, onSelectSuggestion, entry }) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef(null);
  const suggestionsRef = useRef(null);
  const addPanel = useAddSpeakerPanel();
  const labels = entry ? entry.labelsFor(addPanel) : null;

  const suggestions = useMemo(() => (agendaItems || []).filter(item =>
    !item.completed && item.name && item.name.toLowerCase().includes((value || '').toLowerCase())
  ), [agendaItems, value]);

  // Only without the controls under the field, which say what a new name does.
  const isCustomName = !labels && value && value.trim() && !suggestions.some(item =>
    item.name.toLowerCase() === value.trim().toLowerCase()
  );

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

  const handleSelect = (item) => {
    if (onSelectSuggestion) {
      onSelectSuggestion(item);
    } else {
      onChange(item.name);
    }
    setShowSuggestions(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e) => {
    // What the filled button does: Update by default, Add with the setting on
    // "add", nothing with no speaker loaded (the field labels the timer). A
    // highlighted suggestion outranks it, as an explicit choice.
    if (e.key === 'Enter' && entry && !(showSuggestions && highlightIndex >= 0 && suggestions.length > 0)) {
      e.preventDefault();
      entry.onCommit();
      setShowSuggestions(false);
      return;
    }
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(prev => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(prev => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[highlightIndex]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Timing Role</label>
        <div className="relative">
          <select
            value={selectedRole}
            onChange={(e) => onRoleChange(e.target.value)}
            className="w-full pl-3 pr-10 py-2 text-base border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none bg-white"
          >
            {roleOptions.map((role) => (
              <option key={role} value={role}>{role}</option>
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
      <div className="relative">
        <label className="block text-sm font-medium text-gray-700 mb-1">Speaker Name</label>
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
          placeholder="Type speaker name..."
          className="w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-3 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {showSuggestions && (suggestions.length > 0 || isCustomName) && (
          <ul
            ref={suggestionsRef}
            className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto"
          >
            {suggestions.map((item, index) => (
              <li
                key={item.id}
                onMouseDown={() => handleSelect(item)}
                onMouseEnter={() => setHighlightIndex(index)}
                className={`px-3 py-2 cursor-pointer text-sm ${
                  index === highlightIndex ? 'bg-blue-50 text-blue-900' : 'text-gray-900 hover:bg-gray-50'
                }`}
              >
                <span className="font-medium">{item.name}</span>
                <span className="text-gray-500 ml-2 text-xs">{item.role}</span>
              </li>
            ))}
            {isCustomName && (
              <li className="px-3 py-2 text-sm text-gray-500 border-t border-gray-100">
                New Speaker: "{value.trim()}"
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Under the field, what it would do and where the speaker stands: the
          status, the actions that say what a tap does, and the add panel. */}
      {labels && (
        <div className="space-y-2">
          <SpeakerStatus labels={labels} className="text-gray-600" />
          <SpeakerEntryControls entry={entry} labels={labels} panel={addPanel} />
          <SpeakerEntryOptions entry={entry} />
        </div>
      )}
    </div>
  )
});
