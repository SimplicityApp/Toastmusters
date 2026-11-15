import { useEffect, useState } from 'react';
import { Music, VideoOff, X } from 'lucide-react';
import { BREAK_QUICK_PICKS, BREAK_TRACKS, BREAK_ROLE } from '@toastmaster-timer/shared';
import { soundEngine, useSoundSettings, useSoundsAccess } from '../hooks/useSounds';
import { formatThreshold } from './format';

/**
 * The pieces design B puts around the timer card (boards B-T02, T11, T12–T15):
 * who is up next, what happened after Finish, video off, the break length and
 * the custom times. Each draws only; TimerTab wires them to useLiveTimer.
 */

/** "Up next: Alex · Table Topics", with a tag when that row still needs a role. */
export function UpNext({ item, needsRole }) {
  if (!item) return null;
  return (
    <div data-testid="up-next" className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-slate-300 px-3 py-2.5 text-[13px] text-slate-600">
      <span className="flex-shrink-0 text-slate-500">Up next</span>
      <span className="min-w-0 flex-1 truncate">
        <strong className="text-gray-900">{item.name}</strong>
        {!needsRole && item.role ? ` · ${item.role}` : ''}
      </span>
      {needsRole && <span className="flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">Pick a role</span>}
    </div>
  );
}

/** After Finish, when the next row cannot be loaded until it has a role. */
export function FinishNotice({ finishedName, nextName, onPickRole, onDismiss }) {
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
      <span className="min-w-0 flex-1">
        {finishedName ? `${finishedName}'s speech is saved to the report. ` : 'Saved to the report. '}
        Next on the agenda: <strong>{nextName || 'the next speaker'}</strong>, who needs a role.
      </span>
      <button type="button" onClick={onPickRole} className="flex-shrink-0 whitespace-nowrap font-semibold text-blue-700 hover:underline">
        Pick role
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="flex-shrink-0 text-amber-700 hover:text-amber-900">
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Video off: the colour has nowhere to go, so say so and offer the fix. */
export function VideoOffNotice({ onTurnOn, busy }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
      <VideoOff className="h-[18px] w-[18px] flex-shrink-0 text-amber-600" aria-hidden="true" />
      <span className="min-w-0 flex-1">Your video is off. Turn it on to show the timer on it.</span>
      <button
        type="button"
        onClick={onTurnOn}
        disabled={busy}
        className="flex-shrink-0 whitespace-nowrap rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {busy ? 'Turning on…' : 'Turn video on'}
      </button>
    </div>
  );
}

/**
 * Parse what someone typed into a time field. In min:sec mode "1:30" is 90 and
 * a bare "2" is two minutes; in seconds mode it is a count of seconds.
 *
 * @returns {number|null} seconds, or null for something unreadable
 */
export function parseTimeText(text, mode) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (mode === 'seconds') return /^\d+$/.test(value) ? Number(value) : null;
  const match = /^(\d{1,3})(?::([0-5]?\d))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2] ?? 0);
}

const showTime = (seconds, mode) => (mode === 'seconds' ? String(seconds) : formatThreshold(seconds));

/** One compact time field: typed as text, committed on blur or Enter. */
export function TimeField({ label, value, mode, onChange, tone = 'text-slate-600' }) {
  const [text, setText] = useState(() => showTime(value, mode));
  useEffect(() => setText(showTime(value, mode)), [value, mode]);

  const commit = () => {
    const seconds = parseTimeText(text, mode);
    if (seconds === null) setText(showTime(value, mode));
    else if (seconds !== value) onChange(seconds);
  };

  return (
    <label className={`flex min-w-0 flex-col gap-[3px] text-[11px] font-semibold ${tone}`}>
      {label}
      <input
        value={text}
        inputMode={mode === 'seconds' ? 'numeric' : 'text'}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        className="h-8 w-full min-w-0 rounded-lg border border-gray-300 px-1.5 text-[13px] font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </label>
  );
}

/** min:sec | seconds, as a small segmented switch. */
export function TimeModeSwitch({ mode, onModeChange }) {
  return (
    <span className="inline-flex rounded-md bg-slate-100 p-0.5 text-[11px]" role="group" aria-label="Time format">
      {[
        ['minsec', 'min:sec'],
        ['seconds', 'seconds'],
      ].map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={mode === id}
          onClick={() => onModeChange(id)}
          className={`rounded-[5px] px-1.5 py-0.5 ${mode === id ? 'bg-white font-semibold text-gray-900' : 'text-slate-500'}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** Custom role: four thresholds in one row (board B-T14). */
export function CustomTimesPanel({ rules, mode, onModeChange, onChange }) {
  const yellowLow = rules.yellow <= rules.green;
  const redLow = rules.red <= rules.yellow;
  return (
    <div className="rounded-xl border border-gray-200 px-3 py-2.5">
      <div className="mb-2 flex items-center">
        <span className="flex-1 text-[13px] font-semibold">Custom times</span>
        <TimeModeSwitch mode={mode} onModeChange={onModeChange} />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <TimeField label="Green" tone="text-green-700" value={rules.green} mode={mode} onChange={(v) => onChange('green', v)} />
        <TimeField label="Yellow" tone="text-yellow-700" value={rules.yellow} mode={mode} onChange={(v) => onChange('yellow', v)} />
        <TimeField label="Red" tone="text-red-700" value={rules.red} mode={mode} onChange={(v) => onChange('red', v)} />
        <TimeField label="Grace" value={rules.graceAfterRed ?? 0} mode={mode} onChange={(v) => onChange('graceAfterRed', v)} />
      </div>
      {yellowLow && <p className="mt-1.5 text-xs text-red-600">Yellow must be greater than Green</p>}
      {redLow && <p className="mt-1.5 text-xs text-red-600">Red must be greater than Yellow</p>}
      <p className="mb-0 mt-2 text-[11px] text-slate-500">Grace: how long after red before the report marks the speech over time.</p>
    </div>
  );
}

/** Take a Break, before it starts: how long (board B-T12). */
export function BreakPanel({ seconds, explanation, mode, onModeChange, onChange }) {
  const [custom, setCustom] = useState(!BREAK_QUICK_PICKS.includes(seconds));
  const pick = 'h-[34px] rounded-lg text-[13px]';
  const on = `${pick} border-2 border-blue-600 bg-blue-50 font-bold text-blue-900`;
  const off = `${pick} border border-gray-200 bg-white hover:bg-slate-50`;
  return (
    <div className="rounded-xl border border-gray-200 px-3 py-2.5">
      <div className="mb-2 flex items-center">
        <span className="flex-1 text-[13px] font-semibold">Break length</span>
        {custom && <TimeModeSwitch mode={mode} onModeChange={onModeChange} />}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {BREAK_QUICK_PICKS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={!custom && seconds === value}
            onClick={() => {
              setCustom(false);
              onChange(value);
            }}
            className={!custom && seconds === value ? on : off}
          >
            {Math.round(value / 60)} min
          </button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setCustom(true)} className={custom ? on : off}>
          Custom
        </button>
      </div>
      {custom && (
        <div className="mt-2 w-28">
          <TimeField label="Length" value={seconds} mode={mode} onChange={onChange} />
        </div>
      )}
      {explanation && <p className="mb-0 mt-2 text-[11px] text-slate-500">{explanation}</p>}
    </div>
  );
}

/**
 * While a break counts down with music on: say what is playing, and let the
 * organizer stop it for this stretch (board B-T13). Pausing and continuing the
 * break starts it again, as it always has.
 */
export function BreakMusicRow({ isRunning, role }) {
  const settings = useSoundSettings();
  const { usable } = useSoundsAccess();
  const [stopped, setStopped] = useState(false);
  useEffect(() => setStopped(false), [isRunning]);

  if (!usable || !settings.music || !isRunning || role !== BREAK_ROLE) return null;
  const track = BREAK_TRACKS.find((t) => t.id === settings.track) || BREAK_TRACKS[0];

  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-gray-200 px-3 py-2.5 text-[13px] text-slate-700">
      <Music className="h-[18px] w-[18px] flex-shrink-0 text-blue-600" aria-hidden="true" />
      <span className="min-w-0 flex-1">{stopped ? 'Break music stopped' : `Break music is playing: ${track.label}`}</span>
      {!stopped && (
        <button
          type="button"
          onClick={() => {
            soundEngine.stopMusic();
            setStopped(true);
          }}
          className="flex-shrink-0 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs hover:bg-slate-50"
        >
          Stop music
        </button>
      )}
    </div>
  );
}

