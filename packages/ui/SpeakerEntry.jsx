import { useId, useState } from 'react';

/**
 * The speaker controls under a name field (#168, on-the-spot speakers): where the
 * speaker on the timer stands, what tapping each action does, the panel that adds
 * a speaker, and the two "Speaker options".
 *
 * Shared by the Zoom app's Live tab panel, design B's speaker popover and the web
 * Live tab, so all three show the same parts in the same words. The words come
 * from `actionLabels` in packages/shared/speakerEntry.js, passed in as `labels`:
 * this package imports nothing but React (README.md), and a label decided here
 * would be one the other surfaces could drift from. The Zoom stage draws its own
 * compact version from the same labels.
 *
 * The rules of the design (mockup v6): the status is a dot, never a button; at
 * most one filled button (Update, or Add in the panel); every other action is an
 * accent-coloured text action with a round icon, a trailing › and a one-line
 * note of what happens.
 *
 * Stock Tailwind and inline SVG only, see README.md.
 *
 * @typedef {Object} SpeakerEntry
 * @property {(add?: {name?: string, role?: string}) => Object} labelsFor -
 *   actionLabels for the app's state, with the add panel's own name and role
 * @property {string[]} roleOptions
 * @property {string} clockRole - the role on the clock, where the add panel starts
 * @property {string} insertPosition - 'afterActive' | 'end'
 * @property {string} enterAction - 'update' | 'add'
 * @property {() => void} onCommit - what Enter in the name field does
 * @property {() => void} onUpdate
 * @property {() => void} onUndo
 * @property {(name: string, role: string) => void} onAddSpeaker
 * @property {() => void} onSwitchToQuickTiming
 * @property {() => void} onBackToAgenda
 * @property {() => void} onSaveToAgenda
 * @property {(position: string) => void} onInsertPositionChange
 * @property {(action: string) => void} onEnterActionChange
 */

const STROKE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  className: 'h-3.5 w-3.5',
};

/** The marks on the text actions, drawn rather than imported (README.md). */
export const SPEAKER_ICONS = {
  add: (
    <svg {...STROKE}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  ),
  quick: (
    <svg {...STROKE}>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </svg>
  ),
  back: (
    <svg {...STROKE}>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  ),
  undo: (
    <svg {...STROKE}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  ),
  cancel: (
    <svg {...STROKE}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
};

/**
 * The add panel's state, kept by whichever control shows the panel so a guest
 * picked from its list can open it with the name filled in.
 *
 * @returns {{open: boolean, name: string, role: string,
 *   show: (role: string, name?: string) => void, setName: (name: string) => void,
 *   setRole: (role: string) => void, close: () => void}}
 */
export function useAddSpeakerPanel() {
  const [panel, setPanel] = useState(null);
  return {
    open: Boolean(panel),
    name: panel?.name ?? '',
    role: panel?.role ?? '',
    show: (role, name = '') => setPanel({ name, role }),
    setName: (name) => setPanel((current) => current && { ...current, name }),
    setRole: (role) => setPanel((current) => current && { ...current, role }),
    close: () => setPanel(null),
  };
}

/** "On the agenda · 2 of 3" or "Not on the agenda", plus "Unsaved changes". A dot, not a button. */
export function SpeakerStatus({ labels, className = '' }) {
  const onAgenda = labels.status.startsWith('On the agenda');
  return (
    <p className={`flex flex-wrap items-center gap-1.5 text-xs ${className}`}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium ${
          onAgenda ? 'bg-blue-50 text-blue-800' : 'bg-gray-100 text-gray-700'
        }`}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
        {labels.status}
      </span>
      {labels.unsaved && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
          {labels.unsaved}
        </span>
      )}
    </p>
  );
}

/**
 * A secondary action: accent text, a round icon, a trailing › and a note of the
 * result. The label is the button's name and the note its description, so a
 * screen reader says what the tap does, then what follows.
 */
export function TextAction({ icon, label, note, onClick }) {
  const noteId = useId();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-describedby={note ? noteId : undefined}
      className="flex w-full items-start gap-2.5 rounded-md py-1.5 text-left text-sm font-medium text-blue-600 hover:text-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <span aria-hidden="true" className="grid h-6 w-6 flex-none place-items-center rounded-full bg-blue-50">
        {icon}
      </span>
      <span className="min-w-0 flex-1 pt-0.5">
        <span className="block">{label}</span>
        {note && <span id={noteId} className="block text-xs font-normal text-gray-500">{note}</span>}
      </span>
      <span aria-hidden="true" className="pt-0.5 text-lg leading-none">›</span>
    </button>
  );
}

/** The one filled button, or the same button outlined when another one is filled. Named and described like TextAction. */
function MainButton({ label, note, onClick, filled = true, disabled = false }) {
  const noteId = useId();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-describedby={note ? noteId : undefined}
      className={`w-full rounded-lg border px-3.5 py-2 text-left text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        filled
          ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
          : 'border-gray-300 bg-white text-gray-900 hover:bg-gray-50'
      }`}
    >
      <span className="block">{label}</span>
      {note && <span id={noteId} className="block text-xs font-normal opacity-90">{note}</span>}
    </button>
  );
}

/**
 * The add panel: its own name and role, one button that says who goes where.
 * Never touches the speaker on the clock. Enter in its name field adds.
 */
export function AddSpeakerPanel({ labels, panel, roleOptions, onAdd }) {
  const name = panel.name.trim();
  const canAdd = Boolean(name) && !labels.addTaken;
  const add = () => {
    if (!canAdd) return;
    onAdd(name, panel.role);
    panel.close();
  };
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-green-600/60 bg-white p-2.5">
      <p className="text-xs font-medium text-green-800">{labels.addHead}</p>
      <input
        type="text"
        value={panel.name}
        onChange={(event) => panel.setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          add();
        }}
        placeholder="New speaker’s name"
        aria-label="New speaker’s name"
        autoComplete="off"
        enterKeyHint="done"
        autoFocus
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <select
        value={panel.role}
        onChange={(event) => panel.setRole(event.target.value)}
        aria-label="Role for the new speaker"
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {roleOptions.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      <MainButton label={labels.addAction} note={labels.addAs} onClick={add} disabled={!canAdd} />
      {labels.addTaken && <p className="text-xs text-red-600">{labels.addTaken}</p>}
      <TextAction icon={SPEAKER_ICONS.cancel} label="Cancel" onClick={panel.close} />
    </div>
  );
}

/**
 * The actions under the name field, then "+ Add a speaker …" or its panel.
 *
 * @param {{entry: SpeakerEntry, labels: Object, panel: ReturnType<typeof useAddSpeakerPanel>}} props
 */
export function SpeakerEntryControls({ entry, labels, panel }) {
  // The add panel's button is the filled one while it is open.
  const updateFilled = !labels.enterAdd && !panel.open;
  return (
    <div className="space-y-1.5">
      {labels.update ? (
        <>
          {labels.enterAdd && (
            <MainButton label={labels.enterAdd} note={labels.enterAddNote} onClick={entry.onCommit} filled={!panel.open} />
          )}
          <MainButton label={labels.update} note={labels.changes} onClick={entry.onUpdate} filled={updateFilled} />
          {labels.updateNote && <p className="text-xs text-gray-500">{labels.updateNote}</p>}
          <TextAction icon={SPEAKER_ICONS.undo} label={labels.undo} note={labels.undoNote} onClick={entry.onUndo} />
        </>
      ) : (
        labels.quickTiming && (
          <TextAction
            icon={SPEAKER_ICONS.quick}
            label={labels.quickTiming}
            note={labels.quickTimingNote}
            onClick={entry.onSwitchToQuickTiming}
          />
        )
      )}
      {labels.save && (
        <TextAction icon={SPEAKER_ICONS.add} label={labels.save} note={labels.saveNote} onClick={entry.onSaveToAgenda} />
      )}
      {labels.backToAgenda && (
        <TextAction
          icon={SPEAKER_ICONS.back}
          label={labels.backToAgenda}
          note={labels.backToAgendaNote}
          onClick={entry.onBackToAgenda}
        />
      )}
      {panel.open ? (
        <AddSpeakerPanel labels={labels} panel={panel} roleOptions={entry.roleOptions} onAdd={entry.onAddSpeaker} />
      ) : (
        <TextAction
          icon={SPEAKER_ICONS.add}
          label={labels.addOpener}
          note={labels.addOpenerNote}
          onClick={() => panel.show(entry.clockRole)}
        />
      )}
    </div>
  );
}

/**
 * "Speaker options", collapsed: where an added speaker goes, and what Enter does
 * in the name field with a speaker on the timer. Both synced settings, so the
 * other look and the other app follow.
 *
 * @param {{entry: SpeakerEntry, className?: string}} props
 */
export function SpeakerEntryOptions({ entry, className = '' }) {
  const id = useId();
  const radio = (group, value, current, onChange, label) => (
    <label className="flex items-center gap-2 py-0.5 text-sm text-gray-800">
      <input
        type="radio"
        name={`${id}-${group}`}
        value={value}
        checked={current === value}
        onChange={() => onChange(value)}
        className="h-4 w-4 accent-blue-600"
      />
      {label}
    </label>
  );
  return (
    <details className={`text-sm ${className}`}>
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-600 hover:text-gray-900">
        Speaker options
      </summary>
      <div className="mt-2 space-y-2">
        <fieldset>
          <legend className="text-xs font-semibold text-gray-500">A speaker you add goes</legend>
          {radio('insert', 'afterActive', entry.insertPosition, entry.onInsertPositionChange, 'Right after the speaker on the timer')}
          {radio('insert', 'end', entry.insertPosition, entry.onInsertPositionChange, 'At the end of the agenda')}
        </fieldset>
        <fieldset>
          <legend className="text-xs font-semibold text-gray-500">Enter in the name field, with a speaker on the timer</legend>
          {radio('enter', 'update', entry.enterAction, entry.onEnterActionChange, 'Updates that speaker')}
          {radio('enter', 'add', entry.enterAction, entry.onEnterActionChange, 'Adds a new speaker')}
        </fieldset>
      </div>
    </details>
  );
}
