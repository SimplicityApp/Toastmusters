import { useRef, useState } from 'react';
import { Check, ChevronDown, Pencil } from 'lucide-react';
import { BREAK_ROLE } from '@toastmaster-timer/shared';
import { thresholdsLine } from './format';
import { moveFocusWithArrows, usePopover } from './usePopover';

const OPTION = 'flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none';

/**
 * The role button on design B's timer card, and the list it opens (board
 * B-T04): every role with its three thresholds, then Custom and Take a Break,
 * then the way to the rules themselves.
 *
 * @param {{
 *   role: string,
 *   roleOptions: string[],
 *   roleRules: Object<string, Object>,
 *   onChange: (role: string) => void,
 *   onEditRules: () => void,
 *   palette: {soft: string, fg: string},
 * }} props
 */
export default function RolePicker({ role, roleOptions, roleRules, onChange, onEditRules, palette }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  usePopover(open, () => setOpen(false), [buttonRef, listRef]);

  const timed = roleOptions.filter((name) => name !== 'Custom' && name !== BREAK_ROLE);
  const special = [
    roleOptions.includes('Custom') && { name: 'Custom', note: 'set your own times' },
    roleOptions.includes(BREAK_ROLE) && { name: BREAK_ROLE, note: 'counts down' },
  ].filter(Boolean);

  const openList = () => {
    setOpen(true);
    setTimeout(() => {
      const selected = listRef.current?.querySelector('[aria-selected="true"]');
      (selected || listRef.current?.querySelector('[role="option"]'))?.focus();
    }, 0);
  };

  const choose = (name) => {
    setOpen(false);
    buttonRef.current?.focus();
    if (name !== role) onChange(name);
  };

  const renderOption = (name, note) => {
    const selected = name === role;
    return (
      <button
        key={name}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => choose(name)}
        className={`${OPTION} ${selected ? 'bg-blue-50' : ''}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? 'font-semibold' : ''}`}>{name}</span>
        <span className={`flex-shrink-0 text-xs ${selected ? 'text-blue-900' : 'text-slate-500'}`}>{note}</span>
        {selected && <Check className="h-3.5 w-3.5 flex-shrink-0 text-blue-600" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <div className="relative min-w-0" style={{ flex: 1 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openList())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Timing role: ${role}. Change role`}
        style={{ background: palette.soft, color: palette.fg }}
        className="flex h-9 w-full items-center justify-between gap-1.5 rounded-[10px] px-2.5 text-sm font-semibold"
      >
        <span className="truncate">{role}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={listRef}
          onKeyDown={(event) => moveFocusWithArrows(event, listRef.current, '[role="option"], [data-edit-rules]')}
          className="absolute right-0 top-full z-30 mt-1.5 w-[300px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-gray-200 bg-white text-gray-900 shadow-[0_12px_28px_rgba(15,23,42,0.22)]"
        >
          <div role="listbox" aria-label="Timing role" className="max-h-80 overflow-y-auto">
            {timed.map((name) => renderOption(name, thresholdsLine(roleRules[name])))}
            {special.length > 0 && <div className="border-t border-slate-100" role="presentation" />}
            {special.map(({ name, note }) => renderOption(name, note))}
          </div>
          <button
            type="button"
            data-edit-rules
            onClick={() => {
              setOpen(false);
              onEditRules();
            }}
            className="flex w-full items-center gap-1.5 border-t border-slate-100 bg-slate-50 px-3 py-2.5 text-left text-[13px] font-semibold text-blue-600 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit roles &amp; timing rules
          </button>
        </div>
      )}
    </div>
  );
}
